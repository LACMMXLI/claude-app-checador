import { and, eq, isNull, or, gte } from 'drizzle-orm';
import { DomainError, isPgError } from '../../common/errors.js';
import { addDays, effectiveTimezone, localDate } from '../../common/time.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';
import { branches, employeeBranchAssignments, employees, organizations } from '../../db/schema/index.js';
import type { AuditService } from '../audit/audit.service.js';
import { generatePin, hashPin, isWellFormedPin } from './pin.js';

export interface EmployeesOptions {
  pepper: string;
  /** Inyectable en pruebas para forzar PIN concretos o colisiones. */
  pinGenerator?: () => string;
  clock?: () => Date;
}

type Employee = typeof employees.$inferSelect;

/** Vista segura de un empleado: nunca incluye `pinHash`. */
export type EmployeeView = Omit<Employee, 'pinHash'>;
const toView = (e: Employee): EmployeeView => {
  const { pinHash: _omit, ...rest } = e;
  return rest;
};

export class EmployeesService {
  private readonly pinGenerator: () => string;
  private readonly clock: () => Date;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly options: EmployeesOptions,
  ) {
    this.pinGenerator = options.pinGenerator ?? (() => generatePin());
    this.clock = options.clock ?? (() => new Date());
  }

  /** Fecha local "hoy" en la zona efectiva de una sucursal. */
  private async branchToday(tx: Tx, ctx: TenantContext, branchId: string): Promise<string> {
    const [row] = await tx
      .select({ branchTz: branches.timezone, orgTz: organizations.timezone })
      .from(branches)
      .innerJoin(organizations, eq(organizations.id, branches.organizationId))
      .where(eq(branches.id, branchId));
    if (!row) throw new DomainError('BRANCH_NOT_FOUND');
    return localDate(this.clock(), effectiveTimezone(row.branchTz, row.orgTz));
  }

  /**
   * Asigna un PIN nuevo único (entre activos del mismo negocio). Devuelve el PIN en claro UNA sola vez;
   * en la base de datos solo queda su hash. Reintenta si por azar colisiona con otro empleado activo.
   */
  private async assignFreshPin(tx: Tx, ctx: TenantContext, employeeId: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pin = this.pinGenerator();
      if (!isWellFormedPin(pin)) throw new Error('El generador de PIN produjo un valor inválido');
      try {
        await tx.transaction(async (sp) => {
          await sp
            .update(employees)
            .set({ pinHash: hashPin(pin, ctx.organizationId, this.options.pepper), pinSetAt: this.clock() })
            .where(eq(employees.id, employeeId));
        });
        return pin;
      } catch (error) {
        if (isPgError(error, '23505', 'employees_pin_unique')) continue; // colisión: otro PIN
        throw error;
      }
    }
    throw new DomainError('PIN_GENERATION_FAILED');
  }

  async create(
    ctx: TenantContext,
    input: {
      employeeNumber: string;
      firstName: string;
      lastName?: string;
      phone?: string;
      primaryBranchId: string;
      hiredAt?: string;
    },
  ): Promise<{ employee: EmployeeView; pin: string }> {
    return this.tenantDb.run(ctx, async (tx) => {
      const today = await this.branchToday(tx, ctx, input.primaryBranchId);
      let created: Employee;
      try {
        [created] = (await tx
          .insert(employees)
          .values({
            organizationId: ctx.organizationId,
            employeeNumber: input.employeeNumber,
            firstName: input.firstName,
            lastName: input.lastName ?? '',
            phone: input.phone ?? null,
            hiredAt: input.hiredAt ?? today,
          })
          .returning()) as [Employee];
      } catch (error) {
        if (isPgError(error, '23505')) throw new DomainError('EMPLOYEE_NUMBER_TAKEN');
        throw error;
      }
      await tx.insert(employeeBranchAssignments).values({
        organizationId: ctx.organizationId,
        employeeId: created.id,
        branchId: input.primaryBranchId,
        kind: 'PRIMARY',
        validFrom: input.hiredAt ?? today,
        createdBy: ctx.actor.userId ?? null,
      });
      const pin = await this.assignFreshPin(tx, ctx, created.id);
      await this.audit.record(tx, ctx, {
        action: 'employee.created',
        entityType: 'employee',
        entityId: created.id,
        branchId: input.primaryBranchId,
        after: toView(created),
      });
      await this.audit.record(tx, ctx, {
        action: 'employee.pin_generated', // sin el PIN ni su hash
        entityType: 'employee',
        entityId: created.id,
        branchId: input.primaryBranchId,
      });
      const [fresh] = await tx.select().from(employees).where(eq(employees.id, created.id));
      return { employee: toView(fresh!), pin };
    });
  }

  async update(
    ctx: TenantContext,
    employeeId: string,
    patch: { firstName?: string; lastName?: string; phone?: string | null; notes?: string | null; employeeNumber?: string },
    reason?: string,
  ): Promise<EmployeeView> {
    return this.tenantDb.run(ctx, async (tx) => {
      const [before] = await tx.select().from(employees).where(eq(employees.id, employeeId));
      if (!before) throw new DomainError('EMPLOYEE_NOT_FOUND');
      try {
        const [after] = await tx.update(employees).set(patch).where(eq(employees.id, employeeId)).returning();
        await this.audit.record(tx, ctx, {
          action: 'employee.updated',
          entityType: 'employee',
          entityId: employeeId,
          before: toView(before),
          after: toView(after!),
          reason,
        });
        return toView(after!);
      } catch (error) {
        if (isPgError(error, '23505')) throw new DomainError('EMPLOYEE_NUMBER_TAKEN');
        throw error;
      }
    });
  }

  /** Restablece el PIN. El anterior deja de funcionar al instante. Solo se muestra una vez. */
  async resetPin(ctx: TenantContext, employeeId: string, reason?: string): Promise<{ pin: string }> {
    return this.tenantDb.run(ctx, async (tx) => {
      const [employee] = await tx.select().from(employees).where(eq(employees.id, employeeId));
      if (!employee) throw new DomainError('EMPLOYEE_NOT_FOUND');
      if (employee.status !== 'ACTIVE') throw new DomainError('EMPLOYEE_INACTIVE');
      const pin = await this.assignFreshPin(tx, ctx, employeeId);
      await this.audit.record(tx, ctx, {
        action: 'employee.pin_reset', // quién, cuándo, a quién; NUNCA el PIN ni su hash
        entityType: 'employee',
        entityId: employeeId,
        reason,
      });
      return { pin };
    });
  }

  /** Baja: no se borra nada; se invalida el PIN y se conserva todo el historial. */
  async deactivate(ctx: TenantContext, employeeId: string, reason: string): Promise<EmployeeView> {
    if (!reason || reason.trim() === '') throw new DomainError('REASON_REQUIRED');
    return this.tenantDb.run(ctx, async (tx) => {
      const [before] = await tx.select().from(employees).where(eq(employees.id, employeeId));
      if (!before) throw new DomainError('EMPLOYEE_NOT_FOUND');
      if (before.status === 'INACTIVE') return toView(before);
      const [primary] = await tx
        .select()
        .from(employeeBranchAssignments)
        .where(and(eq(employeeBranchAssignments.employeeId, employeeId), eq(employeeBranchAssignments.kind, 'PRIMARY'), isNull(employeeBranchAssignments.validTo)));
      const today = primary ? await this.branchToday(tx, ctx, primary.branchId) : localDate(this.clock(), 'UTC');
      const [after] = await tx
        .update(employees)
        .set({ status: 'INACTIVE', pinHash: null, terminatedAt: today, terminationReason: reason })
        .where(eq(employees.id, employeeId))
        .returning();
      await this.audit.record(tx, ctx, {
        action: 'employee.deactivated',
        entityType: 'employee',
        entityId: employeeId,
        branchId: primary?.branchId ?? null,
        before: toView(before),
        after: toView(after!),
        reason,
      });
      return toView(after!);
    });
  }

  /** Reingreso: se reactiva el mismo registro con un PIN nuevo. */
  async reactivate(ctx: TenantContext, employeeId: string, reason?: string): Promise<{ employee: EmployeeView; pin: string }> {
    return this.tenantDb.run(ctx, async (tx) => {
      const [before] = await tx.select().from(employees).where(eq(employees.id, employeeId));
      if (!before) throw new DomainError('EMPLOYEE_NOT_FOUND');
      if (before.status === 'ACTIVE') throw new DomainError('EMPLOYEE_ALREADY_ACTIVE');
      await tx.update(employees).set({ status: 'ACTIVE', terminatedAt: null, terminationReason: null }).where(eq(employees.id, employeeId));
      const pin = await this.assignFreshPin(tx, ctx, employeeId);
      const [after] = await tx.select().from(employees).where(eq(employees.id, employeeId));
      await this.audit.record(tx, ctx, {
        action: 'employee.reactivated',
        entityType: 'employee',
        entityId: employeeId,
        before: toView(before),
        after: toView(after!),
        reason,
      });
      return { employee: toView(after!), pin };
    });
  }

  /**
   * Asigna sucursal. PRIMARY: cierra la primaria vigente (el historial se conserva) y abre la nueva.
   * TEMPORARY: rango de fechas y motivo, siempre dentro del mismo negocio (FK compuesta).
   */
  async assignBranch(
    ctx: TenantContext,
    employeeId: string,
    input: { branchId: string; kind: 'PRIMARY' | 'TEMPORARY'; validFrom: string; validTo?: string | null; reason?: string },
  ) {
    if (input.kind === 'TEMPORARY' && (!input.validTo || !input.reason)) throw new DomainError('TEMPORARY_ASSIGNMENT_REQUIRES_RANGE_AND_REASON');
    return this.tenantDb.run(ctx, async (tx) => {
      const [employee] = await tx.select().from(employees).where(eq(employees.id, employeeId));
      if (!employee) throw new DomainError('EMPLOYEE_NOT_FOUND');
      const [branch] = await tx.select().from(branches).where(eq(branches.id, input.branchId));
      if (!branch) throw new DomainError('BRANCH_NOT_FOUND');

      if (input.kind === 'PRIMARY') {
        const open = await tx
          .select()
          .from(employeeBranchAssignments)
          .where(
            and(
              eq(employeeBranchAssignments.employeeId, employeeId),
              eq(employeeBranchAssignments.kind, 'PRIMARY'),
              or(isNull(employeeBranchAssignments.validTo), gte(employeeBranchAssignments.validTo, input.validFrom)),
            ),
          );
        for (const current of open) {
          await tx
            .update(employeeBranchAssignments)
            .set({ validTo: addDays(input.validFrom, -1) })
            .where(eq(employeeBranchAssignments.id, current.id));
          await this.audit.record(tx, ctx, {
            action: 'employee.assignment_closed',
            entityType: 'employee_branch_assignment',
            entityId: current.id,
            branchId: current.branchId,
            before: current,
            after: { ...current, validTo: addDays(input.validFrom, -1) },
          });
        }
      }
      try {
        const [created] = await tx
          .insert(employeeBranchAssignments)
          .values({
            organizationId: ctx.organizationId,
            employeeId,
            branchId: input.branchId,
            kind: input.kind,
            validFrom: input.validFrom,
            validTo: input.validTo ?? null,
            reason: input.reason ?? null,
            createdBy: ctx.actor.userId ?? null,
          })
          .returning();
        await this.audit.record(tx, ctx, {
          action: 'employee.assignment_created',
          entityType: 'employee_branch_assignment',
          entityId: created!.id,
          branchId: input.branchId,
          after: created,
          reason: input.reason,
        });
        return created!;
      } catch (error) {
        if (isPgError(error, '23P01')) throw new DomainError('PRIMARY_ASSIGNMENT_OVERLAP');
        throw error;
      }
    });
  }

  /** Identifica a un empleado ACTIVO del negocio por su PIN (el kiosco lo usa tras validar intentos). */
  async findActiveByPin(tx: Tx, ctx: TenantContext, pin: string): Promise<EmployeeView | null> {
    if (!isWellFormedPin(pin)) return null;
    const [row] = await tx
      .select()
      .from(employees)
      .where(and(eq(employees.pinHash, hashPin(pin, ctx.organizationId, this.options.pepper)), eq(employees.status, 'ACTIVE')));
    return row ? toView(row) : null;
  }
}

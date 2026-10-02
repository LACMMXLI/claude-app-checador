import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { DomainError, isPgError } from '../../common/errors.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';
import { effectiveTimezone } from '../../common/time.js';
import { addDaysToDate, type Fold, weekStartOf } from '../../common/zoned-time.js';
import { branches, employeeBranchAssignments, employees, organizations, shifts, weeklySchedules } from '../../db/schema/index.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AccessProfile } from '../auth/rbac.service.js';
import type { PoliciesService } from '../policies/policies.service.js';
import { assertDuration, localView, resolveShiftTime, temporalState } from './shift-time.js';

type ShiftRow = typeof shifts.$inferSelect;
type ScheduleRow = typeof weeklySchedules.$inferSelect;

export interface ShiftInput {
  employeeId: string;
  branchId: string;
  date: string;
  startTime: string;
  endTime: string;
  startFold?: Fold;
  endFold?: Fold;
  notes?: string | null;
}

export interface ShiftPatch {
  employeeId?: string;
  branchId?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  startFold?: Fold;
  endFold?: Fold;
  notes?: string | null;
}

export interface CopyConflict {
  sourceShiftId: string | null;
  employeeId: string;
  date: string;
  startTime: string;
  endTime: string;
  code: string;
  details: Record<string, unknown>;
}

/** Candidato a generarse (copiar semana o aplicar plantilla). */
export interface ShiftCandidate {
  employeeId: string;
  date: string;
  startTime: string;
  endTime: string;
  source: 'COPY' | 'TEMPLATE';
  sourceShiftId?: string;
  sourceTemplateId?: string;
}

export interface GenerationResult {
  branchId: string;
  weekStart: string;
  scheduleId: string;
  dryRun: boolean;
  created: ReturnType<typeof shiftView>[];
  conflicts: CopyConflict[];
}

class DryRunRollback extends Error {
  constructor(public readonly result: unknown) {
    super('dry-run');
  }
}

export function shiftView(row: ShiftRow, scheduleStatus?: string) {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    scheduleStatus: scheduleStatus ?? null,
    branchId: row.branchId,
    employeeId: row.employeeId,
    businessDate: row.businessDate,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    timezone: row.timezoneSnapshot,
    ...localView(row),
    scheduledMinutes: row.scheduledMinutes,
    status: row.status,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    notes: row.notes,
    source: row.source,
    sourceShiftId: row.sourceShiftId,
    version: row.version,
  };
}

/**
 * Planificación (Fase 2): horario semanal por sucursal (DRAFT → PUBLISHED) y turnos concretos.
 * El turno concreto es la fuente de verdad para la asistencia (D-22). Todas las reglas de tiempo
 * usan la zona IANA efectiva de la sucursal y guardan `timezone_snapshot` (D-26/D-28).
 * Autorización por sucursal (D-30) y protección de turnos históricos (D-32) se aplican aquí,
 * además del RLS de PostgreSQL como última capa.
 */
export class SchedulingService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly policies: PoliciesService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ── utilidades ───────────────────────────────────────────────────────────────
  private async branchInfo(tx: Tx, branchId: string) {
    const [row] = await tx
      .select({ id: branches.id, isActive: branches.isActive, branchTz: branches.timezone, orgTz: organizations.timezone, name: branches.name })
      .from(branches)
      .innerJoin(organizations, eq(organizations.id, branches.organizationId))
      .where(eq(branches.id, branchId));
    if (!row) throw new DomainError('BRANCH_NOT_FOUND');
    return { ...row, timezone: effectiveTimezone(row.branchTz, row.orgTz) };
  }

  private async weekStartDay(tx: Tx, ctx: TenantContext, branchId?: string): Promise<number> {
    return (await this.policies.getEffectiveTx(tx, ctx, { branchId })).policy.weekStartDay;
  }

  private async assertEmployeeSchedulable(tx: Tx, employeeId: string, branchId: string, date: string) {
    const [emp] = await tx.select({ id: employees.id, status: employees.status }).from(employees).where(eq(employees.id, employeeId));
    if (!emp) throw new DomainError('EMPLOYEE_NOT_FOUND');
    if (emp.status !== 'ACTIVE') throw new DomainError('EMPLOYEE_INACTIVE');
    // D-30: la planificación es estricta — solo empleados asignados a esa sucursal en esa fecha
    const [assignment] = await tx
      .select({ id: employeeBranchAssignments.id })
      .from(employeeBranchAssignments)
      .where(
        and(
          eq(employeeBranchAssignments.employeeId, employeeId),
          eq(employeeBranchAssignments.branchId, branchId),
          lte(employeeBranchAssignments.validFrom, date),
          or(isNull(employeeBranchAssignments.validTo), gte(employeeBranchAssignments.validTo, date)),
        ),
      )
      .limit(1);
    if (!assignment) throw new DomainError('EMPLOYEE_NOT_ASSIGNED_TO_BRANCH', { employeeId, branchId, date });
  }

  /** Turnos activos del empleado que se traslapan con [inicio, fin), en CUALQUIER sucursal del negocio. */
  private async overlapping(tx: Tx, access: AccessProfile, employeeId: string, startsAt: Date, endsAt: Date, excludeId?: string) {
    const rows = await tx
      .select()
      .from(shifts)
      .where(
        and(
          eq(shifts.employeeId, employeeId),
          eq(shifts.status, 'SCHEDULED'),
          lt(shifts.startsAt, endsAt),
          gt(shifts.endsAt, startsAt),
          excludeId ? ne(shifts.id, excludeId) : undefined,
        ),
      );
    // Detalle solo de lo que el usuario puede ver; del resto, únicamente el rango horario.
    return rows.map((r) =>
      access.can('schedules.view', r.branchId)
        ? { shiftId: r.id, branchId: r.branchId, startsAt: r.startsAt, endsAt: r.endsAt }
        : { shiftId: null, branchId: null, startsAt: r.startsAt, endsAt: r.endsAt },
    );
  }

  private async assertNoOverlap(tx: Tx, access: AccessProfile, employeeId: string, startsAt: Date, endsAt: Date, excludeId?: string) {
    const conflicts = await this.overlapping(tx, access, employeeId, startsAt, endsAt, excludeId);
    if (conflicts.length) throw new DomainError('SHIFT_OVERLAP', { conflicts });
  }

  /** Horario semanal de la sucursal para esa semana (lo crea en DRAFT si no existe). Bloquea la fila. */
  private async scheduleFor(tx: Tx, ctx: TenantContext, branchId: string, weekStart: string): Promise<ScheduleRow> {
    await tx
      .insert(weeklySchedules)
      .values({ organizationId: ctx.organizationId, branchId, weekStart, createdBy: ctx.actor.userId ?? null })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(weeklySchedules)
      .where(and(eq(weeklySchedules.branchId, branchId), eq(weeklySchedules.weekStart, weekStart)))
      .for('update');
    return row!;
  }

  private async bumpSchedule(tx: Tx, scheduleId: string) {
    await tx.update(weeklySchedules).set({ version: sql`${weeklySchedules.version} + 1` }).where(eq(weeklySchedules.id, scheduleId));
  }

  /** D-32: cambios sobre turnos que ya comenzaron o terminaron (o crear en el pasado) ⇒ permiso de historial + motivo. */
  private assertHistoryAllowed(access: AccessProfile, branchId: string, reason: string | undefined, state: string) {
    if (!access.can('schedules.history.manage', branchId)) throw new DomainError('SHIFT_HISTORY_LOCKED', { state });
    if (!reason || !reason.trim()) throw new DomainError('REASON_REQUIRED', { state });
  }

  private async loadShiftForUpdate(tx: Tx, shiftId: string) {
    const [row] = await tx.select().from(shifts).where(eq(shifts.id, shiftId)).for('update');
    if (!row) throw new DomainError('SHIFT_NOT_FOUND');
    return row;
  }

  private async scheduleStatus(tx: Tx, scheduleId: string) {
    const [s] = await tx.select({ status: weeklySchedules.status }).from(weeklySchedules).where(eq(weeklySchedules.id, scheduleId));
    return s?.status ?? null;
  }

  // ── consultas ────────────────────────────────────────────────────────────────
  /** Horario semanal de una sucursal: semana normalizada, empleados asignados y turnos (incluye cancelados). */
  async getWeek(ctx: TenantContext, access: AccessProfile, branchId: string, anyDate: string) {
    if (!access.can('schedules.view', branchId)) throw new DomainError('BRANCH_NOT_FOUND');
    return this.tenantDb.run(ctx, async (tx) => {
      const branch = await this.branchInfo(tx, branchId);
      const weekStart = weekStartOf(anyDate, await this.weekStartDay(tx, ctx, branchId));
      const weekEnd = addDaysToDate(weekStart, 6);
      const [schedule] = await tx
        .select()
        .from(weeklySchedules)
        .where(and(eq(weeklySchedules.branchId, branchId), eq(weeklySchedules.weekStart, weekStart)));
      const rows = schedule
        ? await tx.select().from(shifts).where(eq(shifts.scheduleId, schedule.id)).orderBy(asc(shifts.startsAt))
        : [];
      const assigned = await tx
        .select({ employeeId: employeeBranchAssignments.employeeId, kind: employeeBranchAssignments.kind })
        .from(employeeBranchAssignments)
        .where(
          and(
            eq(employeeBranchAssignments.branchId, branchId),
            lte(employeeBranchAssignments.validFrom, weekEnd),
            or(isNull(employeeBranchAssignments.validTo), gte(employeeBranchAssignments.validTo, weekStart)),
          ),
        );
      const ids = [...new Set([...assigned.map((a) => a.employeeId), ...rows.map((r) => r.employeeId)])];
      const people = ids.length
        ? await tx
            .select({ id: employees.id, employeeNumber: employees.employeeNumber, firstName: employees.firstName, lastName: employees.lastName, status: employees.status })
            .from(employees)
            .where(inArray(employees.id, ids))
            .orderBy(asc(employees.firstName), asc(employees.lastName))
        : [];
      return {
        branch: { id: branch.id, name: branch.name, timezone: branch.timezone, isActive: branch.isActive },
        weekStart,
        days: Array.from({ length: 7 }, (_, i) => addDaysToDate(weekStart, i)),
        schedule: schedule ? { id: schedule.id, status: schedule.status, version: schedule.version, publishedAt: schedule.publishedAt } : null,
        employees: people
          .filter((p) => p.status === 'ACTIVE' || rows.some((r) => r.employeeId === p.id))
          .map((p) => ({ ...p, temporary: !assigned.some((a) => a.employeeId === p.id && a.kind === 'PRIMARY') && assigned.some((a) => a.employeeId === p.id) })),
        shifts: rows.map((r) => shiftView(r, schedule?.status)),
      };
    });
  }

  async getShift(ctx: TenantContext, access: AccessProfile, shiftId: string) {
    return this.tenantDb.run(ctx, async (tx) => {
      const [row] = await tx.select().from(shifts).where(eq(shifts.id, shiftId));
      if (!row || !access.can('schedules.view', row.branchId)) throw new DomainError('SHIFT_NOT_FOUND');
      return shiftView(row, (await this.scheduleStatus(tx, row.scheduleId)) ?? undefined);
    });
  }

  /** Próximos turnos de un empleado (solo de sucursales visibles para el usuario). */
  async employeeShifts(ctx: TenantContext, access: AccessProfile, employeeId: string, opts: { from?: Date; limit?: number } = {}) {
    const from = opts.from ?? this.clock();
    return this.tenantDb.run(ctx, async (tx) => {
      const rows = await tx
        .select({ shift: shifts, scheduleStatus: weeklySchedules.status })
        .from(shifts)
        .innerJoin(weeklySchedules, eq(weeklySchedules.id, shifts.scheduleId))
        .where(and(eq(shifts.employeeId, employeeId), gt(shifts.endsAt, from)))
        .orderBy(asc(shifts.startsAt))
        .limit(Math.min(opts.limit ?? 30, 200));
      return rows.filter((r) => access.can('schedules.view', r.shift.branchId)).map((r) => shiftView(r.shift, r.scheduleStatus));
    });
  }

  // ── horario semanal ──────────────────────────────────────────────────────────
  async ensureSchedule(ctx: TenantContext, access: AccessProfile, branchId: string, anyDate: string) {
    if (!access.can('schedules.manage', branchId)) throw new DomainError('FORBIDDEN', { permission: 'schedules.manage' });
    return this.tenantDb.run(ctx, async (tx) => {
      const branch = await this.branchInfo(tx, branchId);
      if (!branch.isActive) throw new DomainError('BRANCH_INACTIVE');
      const weekStart = weekStartOf(anyDate, await this.weekStartDay(tx, ctx, branchId));
      const before = await tx.select({ id: weeklySchedules.id }).from(weeklySchedules).where(and(eq(weeklySchedules.branchId, branchId), eq(weeklySchedules.weekStart, weekStart)));
      const schedule = await this.scheduleFor(tx, ctx, branchId, weekStart);
      if (before.length === 0) {
        await this.audit.record(tx, ctx, { action: 'schedule.created', entityType: 'weekly_schedule', entityId: schedule.id, branchId, after: { weekStart, status: schedule.status } });
      }
      return { id: schedule.id, branchId, weekStart, status: schedule.status, version: schedule.version };
    });
  }

  /** Publicar (acción explícita, D-24): la semana pasa a ser la planificación oficial. Exige la versión vista. */
  async publish(ctx: TenantContext, access: AccessProfile, scheduleId: string, expectedVersion: number) {
    return this.tenantDb.run(ctx, async (tx) => {
      const [schedule] = await tx.select().from(weeklySchedules).where(eq(weeklySchedules.id, scheduleId)).for('update');
      if (!schedule || !access.can('schedules.view', schedule.branchId)) throw new DomainError('SCHEDULE_NOT_FOUND');
      if (!access.can('schedules.manage', schedule.branchId)) throw new DomainError('FORBIDDEN', { permission: 'schedules.manage' });
      if (schedule.version !== expectedVersion) throw new DomainError('SCHEDULE_VERSION_CONFLICT', { currentVersion: schedule.version });
      if (schedule.status === 'PUBLISHED') throw new DomainError('SCHEDULE_ALREADY_PUBLISHED');
      const [after] = await tx
        .update(weeklySchedules)
        .set({ status: 'PUBLISHED', publishedAt: this.clock(), publishedBy: ctx.actor.userId ?? null, version: schedule.version + 1 })
        .where(eq(weeklySchedules.id, scheduleId))
        .returning();
      const [{ count }] = (await tx.execute(
        sql`select count(*)::int as count from scheduling.shifts where schedule_id = ${scheduleId} and status = 'SCHEDULED'`,
      )).rows as [{ count: number }];
      await this.audit.record(tx, ctx, {
        action: 'schedule.published',
        entityType: 'weekly_schedule',
        entityId: scheduleId,
        branchId: schedule.branchId,
        before: { status: schedule.status, version: schedule.version },
        after: { status: 'PUBLISHED', version: after!.version, weekStart: schedule.weekStart, shifts: count },
      });
      return { id: after!.id, status: after!.status, version: after!.version, publishedAt: after!.publishedAt };
    });
  }

  // ── turnos ───────────────────────────────────────────────────────────────────
  /** Valida todo y calcula los instantes (sin escribir). Reutilizado por crear, editar y generar. */
  private async prepare(
    tx: Tx,
    ctx: TenantContext,
    access: AccessProfile,
    input: ShiftInput,
    opts: { excludeShiftId?: string; reason?: string; fixed?: { startsAt: Date; endsAt: Date; businessDate: string } },
  ) {
    if (!access.can('schedules.manage', input.branchId)) throw new DomainError('FORBIDDEN', { permission: 'schedules.manage', branchId: input.branchId });
    const branch = await this.branchInfo(tx, input.branchId);
    if (!branch.isActive) throw new DomainError('BRANCH_INACTIVE');
    await this.assertEmployeeSchedulable(tx, input.employeeId, input.branchId, input.date);
    // `fixed`: se conservan los instantes ya guardados (p. ej. solo se reasigna el empleado)
    const time = opts.fixed
      ? { ...opts.fixed, endDate: '', minutes: Math.round((opts.fixed.endsAt.getTime() - opts.fixed.startsAt.getTime()) / 60_000) }
      : resolveShiftTime(input, branch.timezone);
    const { policy } = await this.policies.getEffectiveTx(tx, ctx, { branchId: input.branchId });
    assertDuration(time.minutes, policy);
    const state = temporalState(time, this.clock());
    if (state !== 'FUTURE') this.assertHistoryAllowed(access, input.branchId, opts.reason, state);
    await this.assertNoOverlap(tx, access, input.employeeId, time.startsAt, time.endsAt, opts.excludeShiftId);
    const weekStart = weekStartOf(input.date, policy.weekStartDay);
    return { branch, time, weekStart, state };
  }

  async createShift(ctx: TenantContext, access: AccessProfile, input: ShiftInput, opts: { reason?: string; dryRun?: boolean } = {}) {
    try {
      return await this.tenantDb.run(ctx, async (tx) => {
        const { branch, time, weekStart, state } = await this.prepare(tx, ctx, access, input, opts);
        const schedule = await this.scheduleFor(tx, ctx, input.branchId, weekStart);
        let row: ShiftRow;
        try {
          [row] = (await tx
            .insert(shifts)
            .values({
              organizationId: ctx.organizationId,
              scheduleId: schedule.id,
              branchId: input.branchId,
              employeeId: input.employeeId,
              businessDate: time.businessDate,
              startsAt: time.startsAt,
              endsAt: time.endsAt,
              timezoneSnapshot: branch.timezone,
              notes: input.notes ?? null,
              createdBy: ctx.actor.userId ?? null,
              updatedBy: ctx.actor.userId ?? null,
            })
            .returning()) as [ShiftRow];
        } catch (error) {
          // Última barrera: la restricción de exclusión de PostgreSQL (carreras entre peticiones)
          if (isPgError(error, '23P01')) throw new DomainError('SHIFT_OVERLAP', { conflicts: [] });
          throw error;
        }
        await this.bumpSchedule(tx, schedule.id);
        await this.audit.record(tx, ctx, {
          action: state === 'FUTURE' ? 'shift.created' : 'shift.created_in_past',
          entityType: 'shift',
          entityId: row.id,
          branchId: input.branchId,
          after: shiftView(row, schedule.status),
          reason: opts.reason,
        });
        const view = shiftView(row, schedule.status);
        if (opts.dryRun) throw new DryRunRollback(view);
        return view;
      });
    } catch (error) {
      if (error instanceof DryRunRollback) return error.result as ReturnType<typeof shiftView>;
      throw error;
    }
  }

  /**
   * Editar / reasignar / cambiar de sucursal u horario (D-31). Concurrencia optimista con `expectedVersion`.
   * Si el turno ya comenzó o terminó (o la nueva hora queda en el pasado): permiso de historial + motivo (D-32).
   */
  async updateShift(ctx: TenantContext, access: AccessProfile, shiftId: string, expectedVersion: number, patch: ShiftPatch, reason?: string) {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.loadShiftForUpdate(tx, shiftId);
      if (!access.can('schedules.view', before.branchId)) throw new DomainError('SHIFT_NOT_FOUND');
      if (!access.can('schedules.manage', before.branchId)) throw new DomainError('FORBIDDEN', { permission: 'schedules.manage' });
      if (before.version !== expectedVersion) throw new DomainError('SHIFT_VERSION_CONFLICT', { currentVersion: before.version });
      if (before.status === 'CANCELLED') throw new DomainError('SHIFT_CANCELLED');
      const now = this.clock();
      const stateBefore = temporalState(before, now);
      if (stateBefore !== 'FUTURE') this.assertHistoryAllowed(access, before.branchId, reason, stateBefore);

      const local = localView(before);
      const timeChanged = ['date', 'startTime', 'endTime', 'branchId', 'startFold', 'endFold'].some((k) => (patch as Record<string, unknown>)[k] !== undefined);
      const target: ShiftInput = {
        employeeId: patch.employeeId ?? before.employeeId,
        branchId: patch.branchId ?? before.branchId,
        date: patch.date ?? before.businessDate,
        startTime: patch.startTime ?? local.startTime,
        endTime: patch.endTime ?? local.endTime,
        startFold: patch.startFold,
        endFold: patch.endFold,
        notes: patch.notes === undefined ? before.notes : patch.notes,
      };
      let values: Partial<ShiftRow> = { notes: target.notes ?? null };
      let scheduleId = before.scheduleId;
      let scheduleStatus = await this.scheduleStatus(tx, before.scheduleId);
      if (timeChanged || target.employeeId !== before.employeeId) {
        const { branch, time, weekStart } = await this.prepare(tx, ctx, access, target, {
          excludeShiftId: before.id,
          reason,
          fixed: timeChanged ? undefined : { startsAt: before.startsAt, endsAt: before.endsAt, businessDate: before.businessDate },
        });
        const schedule = await this.scheduleFor(tx, ctx, target.branchId, weekStart);
        scheduleId = schedule.id;
        scheduleStatus = schedule.status;
        values = {
          ...values,
          employeeId: target.employeeId,
          branchId: target.branchId,
          scheduleId: schedule.id,
          businessDate: time.businessDate,
          startsAt: time.startsAt,
          endsAt: time.endsAt,
          // la zona se re-captura solo cuando se recalculan los instantes (D-26)
          timezoneSnapshot: timeChanged ? branch.timezone : before.timezoneSnapshot,
        };
      }
      let after: ShiftRow | undefined;
      try {
        [after] = await tx
          .update(shifts)
          .set({ ...values, version: before.version + 1, updatedBy: ctx.actor.userId ?? null })
          .where(and(eq(shifts.id, shiftId), eq(shifts.version, expectedVersion)))
          .returning();
      } catch (error) {
        if (isPgError(error, '23P01')) throw new DomainError('SHIFT_OVERLAP', { conflicts: [] });
        throw error;
      }
      if (!after) throw new DomainError('SHIFT_VERSION_CONFLICT');
      await this.bumpSchedule(tx, before.scheduleId);
      if (scheduleId !== before.scheduleId) await this.bumpSchedule(tx, scheduleId);
      await this.audit.record(tx, ctx, {
        action: stateBefore === 'FUTURE' ? 'shift.updated' : 'shift.history_corrected',
        entityType: 'shift',
        entityId: shiftId,
        branchId: after.branchId,
        before: shiftView(before),
        after: shiftView(after, scheduleStatus ?? undefined),
        reason,
      });
      return shiftView(after, scheduleStatus ?? undefined);
    });
  }

  /** Cancelar (D-24/D-31): conserva el turno, motivo obligatorio, auditado. */
  async cancelShift(ctx: TenantContext, access: AccessProfile, shiftId: string, expectedVersion: number, reason: string) {
    if (!reason || !reason.trim()) throw new DomainError('REASON_REQUIRED');
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.loadShiftForUpdate(tx, shiftId);
      if (!access.can('schedules.view', before.branchId)) throw new DomainError('SHIFT_NOT_FOUND');
      if (!access.can('schedules.manage', before.branchId)) throw new DomainError('FORBIDDEN', { permission: 'schedules.manage' });
      if (before.version !== expectedVersion) throw new DomainError('SHIFT_VERSION_CONFLICT', { currentVersion: before.version });
      if (before.status === 'CANCELLED') throw new DomainError('SHIFT_CANCELLED');
      const state = temporalState(before, this.clock());
      if (state !== 'FUTURE') this.assertHistoryAllowed(access, before.branchId, reason, state);
      const [after] = await tx
        .update(shifts)
        .set({ status: 'CANCELLED', cancelledAt: this.clock(), cancelledBy: ctx.actor.userId ?? null, cancelReason: reason.trim(), version: before.version + 1, updatedBy: ctx.actor.userId ?? null })
        .where(and(eq(shifts.id, shiftId), eq(shifts.version, expectedVersion)))
        .returning();
      if (!after) throw new DomainError('SHIFT_VERSION_CONFLICT');
      await this.bumpSchedule(tx, before.scheduleId);
      await this.audit.record(tx, ctx, {
        action: state === 'FUTURE' ? 'shift.cancelled' : 'shift.history_cancelled',
        entityType: 'shift',
        entityId: shiftId,
        branchId: before.branchId,
        before: shiftView(before),
        after: { status: 'CANCELLED', version: after.version },
        reason,
      });
      return shiftView(after, (await this.scheduleStatus(tx, after.scheduleId)) ?? undefined);
    });
  }

  /** Quitar un turno de un BORRADOR (nunca publicado). En publicados se cancela (lo impone también un trigger). */
  async deleteDraftShift(ctx: TenantContext, access: AccessProfile, shiftId: string, expectedVersion: number, reason?: string) {
    await this.tenantDb.run(ctx, async (tx) => {
      const before = await this.loadShiftForUpdate(tx, shiftId);
      if (!access.can('schedules.view', before.branchId)) throw new DomainError('SHIFT_NOT_FOUND');
      if (!access.can('schedules.manage', before.branchId)) throw new DomainError('FORBIDDEN', { permission: 'schedules.manage' });
      if (before.version !== expectedVersion) throw new DomainError('SHIFT_VERSION_CONFLICT', { currentVersion: before.version });
      if ((await this.scheduleStatus(tx, before.scheduleId)) !== 'DRAFT') throw new DomainError('SHIFT_PUBLISHED_USE_CANCEL');
      const state = temporalState(before, this.clock());
      if (state !== 'FUTURE') this.assertHistoryAllowed(access, before.branchId, reason, state);
      await tx.delete(shifts).where(and(eq(shifts.id, shiftId), eq(shifts.version, expectedVersion)));
      await this.bumpSchedule(tx, before.scheduleId);
      await this.audit.record(tx, ctx, { action: 'shift.deleted_from_draft', entityType: 'shift', entityId: shiftId, branchId: before.branchId, before: shiftView(before), reason });
    });
  }

  // ── generación: copiar semana / aplicar plantilla ────────────────────────────
  /**
   * Genera turnos en el horario de la semana destino (debe estar en BORRADOR).
   * Decisión: copia PARCIAL segura — cada turno se valida y se inserta en su propio SAVEPOINT; lo que no
   * puede crearse se devuelve en `conflicts` con su motivo (nada desaparece en silencio). `dryRun` hace
   * exactamente lo mismo dentro de una transacción que se revierte (vista previa de conflictos).
   * Idempotente: un mismo turno de origen no se copia dos veces al mismo horario (índice único).
   */
  async generate(
    ctx: TenantContext,
    access: AccessProfile,
    params: { branchId: string; targetWeekStart: string; candidates: (tx: Tx, weekStartDay: number) => Promise<ShiftCandidate[]>; dryRun?: boolean; auditAction: string; auditExtra?: Record<string, unknown> },
  ): Promise<GenerationResult> {
    if (!access.can('schedules.manage', params.branchId)) throw new DomainError('FORBIDDEN', { permission: 'schedules.manage' });
    try {
      return await this.tenantDb.run(ctx, async (tx) => {
        const branch = await this.branchInfo(tx, params.branchId);
        if (!branch.isActive) throw new DomainError('BRANCH_INACTIVE');
        const weekStartDay = await this.weekStartDay(tx, ctx, params.branchId);
        const weekStart = weekStartOf(params.targetWeekStart, weekStartDay);
        const schedule = await this.scheduleFor(tx, ctx, params.branchId, weekStart);
        if (schedule.status !== 'DRAFT') throw new DomainError('SCHEDULE_NOT_DRAFT');
        const candidates = await params.candidates(tx, weekStartDay);
        const result: GenerationResult = { branchId: params.branchId, weekStart, scheduleId: schedule.id, dryRun: Boolean(params.dryRun), created: [], conflicts: [] };

        for (const c of candidates) {
          const conflict = (code: string, details: Record<string, unknown> = {}) =>
            result.conflicts.push({ sourceShiftId: c.sourceShiftId ?? null, employeeId: c.employeeId, date: c.date, startTime: c.startTime, endTime: c.endTime, code, details });
          if (c.date < weekStart || c.date > addDaysToDate(weekStart, 6)) {
            conflict('OUTSIDE_TARGET_WEEK');
            continue;
          }
          if (c.sourceShiftId) {
            const dup = await tx
              .select({ id: shifts.id })
              .from(shifts)
              .where(and(eq(shifts.scheduleId, schedule.id), eq(shifts.sourceShiftId, c.sourceShiftId), eq(shifts.status, 'SCHEDULED')));
            if (dup.length) {
              conflict('ALREADY_COPIED', { shiftId: dup[0]!.id });
              continue;
            }
          }
          try {
            const row = await tx.transaction(async (sp) => {
              const { time } = await this.prepare(sp, ctx, access, { employeeId: c.employeeId, branchId: params.branchId, date: c.date, startTime: c.startTime, endTime: c.endTime }, {});
              const [inserted] = await sp
                .insert(shifts)
                .values({
                  organizationId: ctx.organizationId,
                  scheduleId: schedule.id,
                  branchId: params.branchId,
                  employeeId: c.employeeId,
                  businessDate: time.businessDate,
                  startsAt: time.startsAt,
                  endsAt: time.endsAt,
                  timezoneSnapshot: branch.timezone,
                  source: c.source,
                  sourceShiftId: c.sourceShiftId ?? null,
                  sourceTemplateId: c.sourceTemplateId ?? null,
                  createdBy: ctx.actor.userId ?? null,
                  updatedBy: ctx.actor.userId ?? null,
                })
                .returning();
              return inserted!;
            });
            result.created.push(shiftView(row, schedule.status));
          } catch (error) {
            if (error instanceof DomainError) conflict(error.code, error.details);
            else if (isPgError(error, '23P01')) conflict('SHIFT_OVERLAP', { conflicts: [] });
            else if (isPgError(error, '23505')) conflict('ALREADY_COPIED');
            else throw error;
          }
        }

        if (result.created.length) await this.bumpSchedule(tx, schedule.id);
        await this.audit.record(tx, ctx, {
          action: params.auditAction,
          entityType: 'weekly_schedule',
          entityId: schedule.id,
          branchId: params.branchId,
          after: {
            weekStart,
            created: result.created.length,
            createdShiftIds: result.created.map((s) => s.id),
            conflicts: result.conflicts.map((x) => ({ employeeId: x.employeeId, date: x.date, code: x.code })),
            ...params.auditExtra,
          },
        });
        if (params.dryRun) throw new DryRunRollback(result);
        return result;
      });
    } catch (error) {
      if (error instanceof DryRunRollback) return error.result as GenerationResult;
      throw error;
    }
  }

  /**
   * Copiar semana: conserva las HORAS LOCALES (no suma 7×24 h en UTC), así un cambio de horario (DST)
   * entre ambas semanas no mueve la hora del turno.
   */
  copyWeek(ctx: TenantContext, access: AccessProfile, input: { branchId: string; sourceWeek: string; targetWeek?: string; dryRun?: boolean }) {
    let sourceWeekStart = '';
    return this.generate(ctx, access, {
      branchId: input.branchId,
      targetWeekStart: input.targetWeek ?? addDaysToDate(input.sourceWeek, 7),
      dryRun: input.dryRun,
      auditAction: 'schedule.week_copied',
      candidates: async (tx, weekStartDay) => {
        sourceWeekStart = weekStartOf(input.sourceWeek, weekStartDay);
        const target = weekStartOf(input.targetWeek ?? addDaysToDate(sourceWeekStart, 7), weekStartDay);
        if (target === sourceWeekStart) throw new DomainError('COPY_SAME_WEEK');
        const offsetDays = Math.round((Date.parse(target) - Date.parse(sourceWeekStart)) / 86_400_000);
        const [source] = await tx
          .select()
          .from(weeklySchedules)
          .where(and(eq(weeklySchedules.branchId, input.branchId), eq(weeklySchedules.weekStart, sourceWeekStart)));
        if (!source) return [];
        const rows = await tx
          .select()
          .from(shifts)
          .where(and(eq(shifts.scheduleId, source.id), eq(shifts.status, 'SCHEDULED')))
          .orderBy(asc(shifts.startsAt));
        return rows.map((r) => {
          const local = localView(r); // horas locales con la zona con la que se creó el turno de origen
          return {
            employeeId: r.employeeId,
            date: addDaysToDate(r.businessDate, offsetDays),
            startTime: local.startTime,
            endTime: local.endTime,
            source: 'COPY' as const,
            sourceShiftId: r.id,
          };
        });
      },
      get auditExtra() {
        return { sourceWeekStart };
      },
    });
  }
}

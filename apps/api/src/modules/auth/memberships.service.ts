import { and, eq } from 'drizzle-orm';
import { DomainError } from '../../common/errors.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';
import {
  employees,
  organizationMemberships,
  roleAssignmentBranches,
  roleAssignments,
  roles,
  users,
} from '../../db/schema/index.js';
import type { AuditService } from '../audit/audit.service.js';

export type MembershipStatus = 'ACTIVE' | 'INACTIVE' | 'REMOVED';

/**
 * Gestión de membresías por el administrador del NEGOCIO (RN-IDN-02): activar, desactivar o quitar la
 * membresía de su negocio y administrar roles/alcance. NO existe ninguna operación sobre credenciales:
 * la contraseña global pertenece a la plataforma (y a nivel BD app_user no tiene acceso a ella).
 */
export class MembershipsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /** Miembros del negocio activo (RLS: nunca ve usuarios que no sean miembros de este negocio). */
  list(ctx: TenantContext) {
    return this.tenantDb.run(ctx, (tx) =>
      tx
        .select({
          membershipId: organizationMemberships.id,
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          status: organizationMemberships.status,
          employeeId: organizationMemberships.employeeId,
        })
        .from(organizationMemberships)
        .innerJoin(users, eq(users.id, organizationMemberships.userId))
        .where(eq(organizationMemberships.organizationId, ctx.organizationId)) // defensa en profundidad (RLS ya lo impone)
        .orderBy(users.email),
    );
  }

  /** ¿Quedaría el negocio sin administradores activos si se excluye esta membresía/asignación? (RN-IDN-05) */
  private async activeAdminsExcluding(tx: Tx, exclude: { membershipId?: string; assignmentId?: string }): Promise<number> {
    const rows = await tx
      .select({ assignmentId: roleAssignments.id, membershipId: roleAssignments.membershipId })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .innerJoin(organizationMemberships, eq(organizationMemberships.id, roleAssignments.membershipId))
      .where(and(eq(roles.name, 'ADMIN'), eq(roles.isSystem, true), eq(roleAssignments.scope, 'ORGANIZATION'), eq(organizationMemberships.status, 'ACTIVE')));
    return rows.filter((r) => r.membershipId !== exclude.membershipId && r.assignmentId !== exclude.assignmentId).length;
  }

  private async holdsOrgAdmin(tx: Tx, membershipId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(and(eq(roleAssignments.membershipId, membershipId), eq(roles.name, 'ADMIN'), eq(roles.isSystem, true), eq(roleAssignments.scope, 'ORGANIZATION')));
    return rows.length > 0;
  }

  async setStatus(ctx: TenantContext, membershipId: string, status: MembershipStatus, reason?: string) {
    return this.tenantDb.run(ctx, async (tx) => {
      const [before] = await tx.select().from(organizationMemberships).where(eq(organizationMemberships.id, membershipId));
      if (!before) throw new DomainError('MEMBERSHIP_NOT_FOUND');
      if (before.status === status) return before;
      if (before.status === 'ACTIVE' && status !== 'ACTIVE' && (await this.holdsOrgAdmin(tx, membershipId))) {
        if ((await this.activeAdminsExcluding(tx, { membershipId })) === 0) throw new DomainError('LAST_ADMIN');
      }
      const [after] = await tx.update(organizationMemberships).set({ status }).where(eq(organizationMemberships.id, membershipId)).returning();
      await this.audit.record(tx, ctx, {
        action: 'membership.status_changed',
        entityType: 'membership',
        entityId: membershipId,
        before: { status: before.status },
        after: { status },
        reason,
      });
      return after!;
    });
  }

  /** Liga (o desliga con null) la ficha de empleado de una membresía: conceptos separados, vínculo opcional. */
  async linkEmployee(ctx: TenantContext, membershipId: string, employeeId: string | null) {
    return this.tenantDb.run(ctx, async (tx) => {
      const [before] = await tx.select().from(organizationMemberships).where(eq(organizationMemberships.id, membershipId));
      if (!before) throw new DomainError('MEMBERSHIP_NOT_FOUND');
      if (employeeId) {
        const [e] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.id, employeeId));
        if (!e) throw new DomainError('EMPLOYEE_NOT_FOUND');
      }
      const [after] = await tx.update(organizationMemberships).set({ employeeId }).where(eq(organizationMemberships.id, membershipId)).returning();
      await this.audit.record(tx, ctx, {
        action: 'membership.employee_linked',
        entityType: 'membership',
        entityId: membershipId,
        before: { employeeId: before.employeeId },
        after: { employeeId },
      });
      return after!;
    });
  }

  /** Asigna un rol con alcance: toda la organización o una lista de sucursales (una cuenta, varias sucursales). */
  async assignRole(
    ctx: TenantContext,
    membershipId: string,
    roleId: string,
    scope: { type: 'ORGANIZATION' } | { type: 'BRANCHES'; branchIds: string[] },
    reason?: string,
  ) {
    if (scope.type === 'BRANCHES' && scope.branchIds.length === 0) throw new DomainError('SCOPE_REQUIRES_BRANCHES');
    return this.tenantDb.run(ctx, async (tx) => {
      const [assignment] = await tx
        .insert(roleAssignments)
        .values({ organizationId: ctx.organizationId, membershipId, roleId, scope: scope.type })
        .returning();
      if (scope.type === 'BRANCHES') {
        await tx
          .insert(roleAssignmentBranches)
          .values([...new Set(scope.branchIds)].map((branchId) => ({ organizationId: ctx.organizationId, assignmentId: assignment!.id, branchId })));
      }
      await this.audit.record(tx, ctx, {
        action: 'role.assigned',
        entityType: 'role_assignment',
        entityId: assignment!.id,
        after: { membershipId, roleId, scope },
        reason,
      });
      return assignment!;
    });
  }

  async revokeRole(ctx: TenantContext, assignmentId: string, reason?: string) {
    await this.tenantDb.run(ctx, async (tx) => {
      const [assignment] = await tx.select().from(roleAssignments).where(eq(roleAssignments.id, assignmentId));
      if (!assignment) throw new DomainError('ASSIGNMENT_NOT_FOUND');
      const [role] = await tx.select().from(roles).where(eq(roles.id, assignment.roleId));
      if (role?.name === 'ADMIN' && role.isSystem && assignment.scope === 'ORGANIZATION') {
        if ((await this.activeAdminsExcluding(tx, { assignmentId })) === 0) throw new DomainError('LAST_ADMIN');
      }
      await tx.delete(roleAssignmentBranches).where(eq(roleAssignmentBranches.assignmentId, assignmentId));
      await tx.delete(roleAssignments).where(eq(roleAssignments.id, assignmentId));
      await this.audit.record(tx, ctx, {
        action: 'role.revoked',
        entityType: 'role_assignment',
        entityId: assignmentId,
        before: assignment,
        reason,
      });
    });
  }
}

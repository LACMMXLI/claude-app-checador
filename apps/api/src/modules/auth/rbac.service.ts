import { eq, inArray } from 'drizzle-orm';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';
import { organizationMemberships, roleAssignmentBranches, roleAssignments, rolePermissions } from '../../db/schema/index.js';
import { DomainError } from '../../common/errors.js';

interface Grant {
  permissions: ReadonlySet<string>;
  /** `null` = todas las sucursales del negocio. */
  branchIds: ReadonlySet<string> | null;
}

/**
 * Permisos efectivos de una membresía: roles con permisos granulares y ALCANCE por asignación
 * (todas las sucursales del negocio o una lista). Una cuenta con varias sucursales = una membresía,
 * una asignación con varias filas de alcance.
 */
export class AccessProfile {
  constructor(
    private readonly grants: readonly Grant[],
    /** Ficha de empleado ligada a la membresía (D-15), para impedir corregir la propia jornada (D-18). */
    public readonly employeeId: string | null = null,
  ) {}

  /** ¿Tiene el permiso (en esa sucursal, si se indica)? */
  can(permission: string, branchId?: string): boolean {
    return this.grants.some(
      (g) => g.permissions.has(permission) && (branchId === undefined ? true : g.branchIds === null || g.branchIds.has(branchId)),
    );
  }

  /** Sucursales sobre las que tiene el permiso: 'ALL' o la lista exacta. */
  branchesFor(permission: string): 'ALL' | ReadonlySet<string> {
    const set = new Set<string>();
    for (const g of this.grants) {
      if (!g.permissions.has(permission)) continue;
      if (g.branchIds === null) return 'ALL';
      g.branchIds.forEach((b) => set.add(b));
    }
    return set;
  }

  /** Todas las sucursales que la membresía puede ver por cualquier permiso: 'ALL' o la lista. */
  visibleBranches(): 'ALL' | ReadonlySet<string> {
    const set = new Set<string>();
    for (const g of this.grants) {
      if (g.permissions.size === 0) continue;
      if (g.branchIds === null) return 'ALL';
      g.branchIds.forEach((b) => set.add(b));
    }
    return set;
  }

  /** Resumen serializable para el panel (qué puede hacer y dónde). */
  summary(): Record<string, 'ALL' | string[]> {
    const out: Record<string, 'ALL' | string[]> = {};
    const all = new Set(this.grants.flatMap((g) => [...g.permissions]));
    for (const p of [...all].sort()) {
      const b = this.branchesFor(p);
      out[p] = b === 'ALL' ? 'ALL' : [...b].sort();
    }
    return out;
  }

  /** ¿Puede ejercer el permiso en TODAS las sucursales indicadas? */
  canAll(permission: string, branchIds: readonly string[]): boolean {
    return branchIds.length > 0 && branchIds.every((b) => this.can(permission, b));
  }

  assert(permission: string, branchId?: string): void {
    if (!this.can(permission, branchId)) throw new DomainError('FORBIDDEN', { permission });
  }
}

export class RbacService {
  constructor(private readonly tenantDb: TenantDb) {}

  loadAccess(ctx: TenantContext, membershipId: string): Promise<AccessProfile> {
    return this.tenantDb.run(ctx, (tx) => this.loadAccessTx(tx, membershipId));
  }

  async loadAccessTx(tx: Tx, membershipId: string): Promise<AccessProfile> {
    const [membership] = await tx.select().from(organizationMemberships).where(eq(organizationMemberships.id, membershipId));
    if (!membership || membership.status !== 'ACTIVE') return new AccessProfile([]);

    const assignments = await tx.select().from(roleAssignments).where(eq(roleAssignments.membershipId, membershipId));
    if (assignments.length === 0) return new AccessProfile([], membership.employeeId);

    const perms = await tx
      .select()
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, [...new Set(assignments.map((a) => a.roleId))]));
    const branchRows = await tx
      .select()
      .from(roleAssignmentBranches)
      .where(inArray(roleAssignmentBranches.assignmentId, assignments.map((a) => a.id)));

    return new AccessProfile(
      assignments.map((a) => ({
        permissions: new Set(perms.filter((p) => p.roleId === a.roleId).map((p) => p.permissionCode)),
        branchIds: a.scope === 'ORGANIZATION' ? null : new Set(branchRows.filter((b) => b.assignmentId === a.id).map((b) => b.branchId)),
      })),
      membership.employeeId,
    );
  }
}

import type { TenantContext } from '../../src/common/tenancy/tenant-context.js';
import type { AccessProfile } from '../../src/modules/auth/rbac.service.js';
import { PASSWORD, type World, uniq, userCtx } from './world.js';

export interface SchedFixture {
  orgId: string;
  slug: string;
  ctx: TenantContext;
  admin: AccessProfile;
  manager: AccessProfile;
  managerCtx: TenantContext;
  VEN: string;
  SMA: string;
  carlos: string; // Venecia
  maria: string; // Venecia
  pedro: string; // San Marcos
  encargadoRoleId: string;
}

/**
 * Fatboy (America/Tijuana): Venecia y San Marcos; Carlos y María en Venecia, Pedro en San Marcos;
 * un encargado SOLO de Venecia. Las fechas de ingreso son anteriores a todas las semanas de prueba.
 */
export async function schedFixture(world: World): Promise<SchedFixture> {
  const slug = uniq('fatboy');
  const p = await world.platformAdmin.createOrganization({
    name: 'Fatboy', slug, timezone: 'America/Tijuana',
    branches: [{ code: 'VEN', name: 'Venecia' }, { code: 'SMA', name: 'San Marcos' }],
    admin: { email: `${slug}@ejemplo.com`, displayName: 'Dueño', password: PASSWORD },
  });
  const ctx = userCtx(p.organizationId, p.adminUserId);
  const VEN = p.branchIds.VEN!;
  const SMA = p.branchIds.SMA!;
  const mk = async (n: string, name: string, branch: string) =>
    (await world.employees.create(ctx, { employeeNumber: n, firstName: name, primaryBranchId: branch, hiredAt: '2026-01-01' })).employee.id;
  const carlos = await mk('C-1', 'Carlos', VEN);
  const maria = await mk('M-1', 'María', VEN);
  const pedro = await mk('P-1', 'Pedro', SMA);

  const mgr = await world.pools.platform.query(
    `WITH u AS (INSERT INTO auth.users (email, display_name) VALUES ($1, 'Encargado VEN') RETURNING id)
     INSERT INTO core.organization_memberships (organization_id, user_id) SELECT $2, id FROM u RETURNING id, user_id`,
    [`enc-${slug}@ejemplo.com`, p.organizationId],
  );
  await world.memberships.assignRole(ctx, mgr.rows[0].id, p.encargadoRoleId, { type: 'BRANCHES', branchIds: [VEN] });
  const managerCtx = userCtx(p.organizationId, mgr.rows[0].user_id);
  return {
    orgId: p.organizationId,
    slug,
    ctx,
    admin: await world.rbac.loadAccess(ctx, p.adminMembershipId),
    manager: await world.rbac.loadAccess(ctx, mgr.rows[0].id),
    managerCtx,
    VEN,
    SMA,
    carlos,
    maria,
    pedro,
    encargadoRoleId: p.encargadoRoleId,
  };
}

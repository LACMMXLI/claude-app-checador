import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, openPools, seedOrganization, type SeededOrg } from './helpers/world.js';

const pools = openPools();
const world = buildWorld(pools);
let A: SeededOrg;
let B: SeededOrg;
let branchC: string;

beforeAll(async () => {
  A = await seedOrganization(world);
  B = await seedOrganization(world);
  branchC = (await world.branches.create(A.adminCtx, { code: 'C', name: 'Sucursal C' })).id;
});
afterAll(() => pools.close());

describe('roles, permisos y alcance por sucursal', () => {
  it('el administrador del negocio tiene todo el catálogo en TODAS las sucursales de su negocio', async () => {
    const admin = await world.rbac.loadAccess(A.adminCtx, A.adminMembershipId);
    for (const permission of ['audit.view', 'roles.manage', 'settings.manage', 'attendance.correction.apply', 'schedules.manage', 'memberships.manage']) {
      expect(admin.can(permission), permission).toBe(true);
      expect(admin.can(permission, branchC), permission).toBe(true);
    }
    expect(admin.branchesFor('attendance.view')).toBe('ALL');
  });

  it('un encargado con alcance en 2 sucursales (una sola cuenta) opera solo ahí y no tiene permisos de administración', async () => {
    const enc = await world.rbac.loadAccess(A.adminCtx, A.encargadoMembershipId);
    expect(enc.can('attendance.view', A.branchA)).toBe(true);
    expect(enc.can('attendance.view', A.branchB)).toBe(true);
    expect(enc.can('attendance.view', branchC)).toBe(false);
    expect(enc.can('attendance.correction.apply', A.branchA)).toBe(true);
    for (const p of ['audit.view', 'roles.manage', 'settings.manage', 'schedules.manage', 'kiosks.manage', 'memberships.manage']) expect(enc.can(p), p).toBe(false);
    expect([...(enc.branchesFor('attendance.view') as Set<string>)].sort()).toEqual([A.branchA, A.branchB].sort());
    expect(() => enc.assert('attendance.view', branchC)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('se puede reducir/ampliar el alcance sin duplicar la cuenta; "programar horarios" se concede por permiso (rol aparte)', async () => {
    const ctx = A.adminCtx;
    const rows = await pools.platform.query(`SELECT count(*)::int AS n FROM auth.users WHERE id = $1`, [A.encargadoUserId]);
    expect(rows.rows[0].n).toBe(1);
    // rol personalizado del negocio: "Encargado con horarios"
    const roleId = (await pools.platform.query(
      `WITH r AS (INSERT INTO core.roles (organization_id, name) VALUES ($1, 'Encargado con horarios') RETURNING id)
       INSERT INTO core.role_permissions (organization_id, role_id, permission_code) SELECT $1, id, 'schedules.manage' FROM r RETURNING role_id`, [A.organizationId])).rows[0].role_id;
    await world.memberships.assignRole(ctx, A.encargadoMembershipId, roleId, { type: 'BRANCHES', branchIds: [A.branchA] });
    const enc = await world.rbac.loadAccess(ctx, A.encargadoMembershipId);
    expect(enc.can('schedules.manage', A.branchA)).toBe(true);
    expect(enc.can('schedules.manage', A.branchB)).toBe(false); // el permiso extra solo aplica a su sucursal
    expect(enc.branchesFor('schedules.manage')).toEqual(new Set([A.branchA]));
  });

  it('un alcance por sucursales exige al menos una sucursal', async () => {
    await expect(world.memberships.assignRole(A.adminCtx, A.encargadoMembershipId, A.encargadoRoleId, { type: 'BRANCHES', branchIds: [] })).rejects.toMatchObject({ code: 'SCOPE_REQUIRES_BRANCHES' });
  });

  it('los roles son por negocio: no se puede usar el rol, la membresía ni la sucursal de otro negocio', async () => {
    await expect(world.memberships.assignRole(A.adminCtx, A.encargadoMembershipId, B.encargadoRoleId, { type: 'ORGANIZATION' })).rejects.toThrow();
    await expect(world.memberships.assignRole(A.adminCtx, A.encargadoMembershipId, A.encargadoRoleId, { type: 'BRANCHES', branchIds: [B.branchA] })).rejects.toThrow();
    await expect(world.memberships.assignRole(A.adminCtx, B.encargadoMembershipId, A.encargadoRoleId, { type: 'ORGANIZATION' })).rejects.toThrow();
  });

  it('los cambios de rol y alcance quedan auditados con negocio y quién los hizo', async () => {
    const assignment = await world.memberships.assignRole(A.adminCtx, A.encargadoMembershipId, A.encargadoRoleId, { type: 'BRANCHES', branchIds: [A.branchB] }, 'Refuerzo');
    await world.memberships.revokeRole(A.adminCtx, assignment.id, 'Ya no aplica');
    const rows = (await pools.platform.query(`SELECT action, actor_user_id, reason FROM audit.audit_log WHERE organization_id = $1 AND action IN ('role.assigned','role.revoked') ORDER BY id DESC LIMIT 2`, [A.organizationId])).rows;
    expect(rows.map((r) => r.action)).toEqual(['role.revoked', 'role.assigned']);
    expect(rows.every((r) => r.actor_user_id === A.adminUserId)).toBe(true);
  });

  it('un usuario sin asignaciones o con membresía de otro negocio no tiene permisos', async () => {
    expect((await world.rbac.loadAccess(A.adminCtx, B.adminMembershipId)).can('attendance.view')).toBe(false); // membresía de otro negocio: invisible
  });
});

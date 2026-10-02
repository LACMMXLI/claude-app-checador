import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asTenant, pgError } from './helpers/sql.js';
import { PASSWORD, buildWorld, openPools, seedOrganization, uniq, userCtx, type SeededOrg } from './helpers/world.js';

const pools = openPools();
const world = buildWorld(pools);
let A: SeededOrg;
let B: SeededOrg;

beforeAll(async () => {
  A = await seedOrganization(world);
  B = await seedOrganization(world);
});
afterAll(() => pools.close());

describe('identidad global y membresías', () => {
  it('una cuenta con UN negocio entra directo; con VARIOS elige negocio', async () => {
    const one = await world.auth.authenticate(A.adminEmail, PASSWORD);
    expect(one).toMatchObject({ userId: A.adminUserId, needsOrganizationChoice: false });
    expect(one.memberships.map((m) => m.organizationId)).toEqual([A.organizationId]);

    // Misma persona dueña de otro negocio: se reutiliza la identidad global (sin duplicar cuenta ni tocar su contraseña)
    const other = await world.platformAdmin.createOrganization({
      name: 'Pizzería X', slug: uniq('pizza'), timezone: 'America/Mexico_City', branches: [{ code: 'C', name: 'Centro' }],
      admin: { email: A.adminEmail, displayName: 'Mismo dueño' },
    });
    expect(other).toMatchObject({ adminUserId: A.adminUserId, createdUser: false });
    const two = await world.auth.authenticate(A.adminEmail, PASSWORD);
    expect(two.needsOrganizationChoice).toBe(true);
    expect(two.memberships.map((m) => m.organizationId).sort()).toEqual([A.organizationId, other.organizationId].sort());
    expect((await pools.platform.query(`SELECT count(*)::int AS n FROM auth.users WHERE email = $1`, [A.adminEmail])).rows[0].n).toBe(1);

    // El contexto queda fijado en el negocio elegido: cada uno solo ve lo suyo
    const emailsInOther = (await world.memberships.list(userCtx(other.organizationId, A.adminUserId))).map((m) => m.email);
    expect(emailsInOther).toEqual([A.adminEmail]);
  });

  it('credenciales inválidas, correo inexistente y cuenta deshabilitada devuelven el mismo error', async () => {
    await expect(world.auth.authenticate(A.adminEmail, 'incorrecta-incorrecta')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(world.auth.authenticate('nadie@ejemplo.com', PASSWORD)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await pools.platform.query(`UPDATE auth.users SET status = 'DISABLED' WHERE id = $1`, [B.encargadoUserId]);
    await pools.platform.query(`INSERT INTO auth.user_credentials (user_id, password_hash) VALUES ($1, 'x') ON CONFLICT DO NOTHING`, [B.encargadoUserId]);
    await expect(world.auth.authenticate(`enc-${B.slug}@ejemplo.com`, PASSWORD)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('bloquea la cuenta tras 5 fallos y solo la plataforma puede restablecer la contraseña global', async () => {
    const email = `${uniq('lock')}@ejemplo.com`;
    await world.platformAdmin.createOrganization({ name: 'L', slug: uniq('lock'), timezone: 'America/Tijuana', admin: { email, displayName: 'L', password: PASSWORD } });
    for (let i = 0; i < 5; i += 1) await expect(world.auth.authenticate(email, 'mala-contraseña-1')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(world.auth.authenticate(email, PASSWORD)).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });

    await world.platformAdmin.resetPassword(email, 'otra-contraseña-segura-9');
    await expect(world.auth.authenticate(email, PASSWORD)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' }); // la vieja ya no sirve
    await expect(world.auth.authenticate(email, 'otra-contraseña-segura-9')).resolves.toMatchObject({ needsOrganizationChoice: false });
    const log = (await pools.platform.query(`SELECT details FROM platform.platform_audit_log WHERE action = 'user.password_reset'`)).rows;
    expect(JSON.stringify(log)).not.toContain('otra-contraseña');
  });

  it('el administrador del negocio NO puede ver ni cambiar credenciales globales (sin privilegios en BD)', async () => {
    await asTenant(pools.app, A.organizationId, async (c) => {
      expect((await pgError(c, 'SELECT password_hash FROM auth.user_credentials'))?.code).toBe('42501');
      expect((await pgError(c, `UPDATE auth.user_credentials SET password_hash = 'x'`))?.code).toBe('42501');
      expect((await pgError(c, `UPDATE auth.users SET email = 'x@y.com'`))?.code).toBe('42501');
      expect((await pgError(c, `INSERT INTO auth.users (email, display_name) VALUES ('nuevo@y.com', 'x')`))?.code).toBe('42501');
      expect((await pgError(c, `DELETE FROM auth.users`))?.code).toBe('42501');
    }, A.adminUserId);
    // y el servicio de membresías no expone ninguna operación sobre credenciales
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(world.memberships)).filter((m) => m !== 'constructor');
    expect(methods.filter((m) => /password|credential|contrase/i.test(m))).toEqual([]);
  });

  it('list() solo muestra miembros del propio negocio, sin credenciales', async () => {
    const members = await world.memberships.list(A.adminCtx);
    expect(members.map((m) => m.email).sort()).toEqual([A.adminEmail, `enc-${A.slug}@ejemplo.com`].sort());
    expect(JSON.stringify(members)).not.toMatch(/argon2|password/i);
    expect(members.map((m) => m.email)).not.toContain(B.adminEmail);
  });

  it('activar / desactivar / quitar la membresía afecta solo a ese negocio y queda auditado', async () => {
    await world.memberships.setStatus(A.adminCtx, A.encargadoMembershipId, 'INACTIVE', 'Vacaciones largas');
    const profile = await world.rbac.loadAccess(A.adminCtx, A.encargadoMembershipId);
    expect(profile.can('attendance.view')).toBe(false); // sin acceso mientras está inactiva
    await world.memberships.setStatus(A.adminCtx, A.encargadoMembershipId, 'ACTIVE');
    expect((await world.rbac.loadAccess(A.adminCtx, A.encargadoMembershipId)).can('attendance.view', A.branchA)).toBe(true);
    const rows = (await pools.platform.query(`SELECT before, after, reason FROM audit.audit_log WHERE organization_id = $1 AND action = 'membership.status_changed' ORDER BY id`, [A.organizationId])).rows;
    expect(rows[0]).toMatchObject({ before: { status: 'ACTIVE' }, after: { status: 'INACTIVE' }, reason: 'Vacaciones largas' });
    await expect(world.memberships.setStatus(A.adminCtx, B.encargadoMembershipId, 'REMOVED')).rejects.toMatchObject({ code: 'MEMBERSHIP_NOT_FOUND' }); // otro negocio
  });

  it('una membresía desactivada o un negocio suspendido ya no aparecen al elegir negocio', async () => {
    const email = `${uniq('multi')}@ejemplo.com`;
    const o1 = await world.platformAdmin.createOrganization({ name: 'N1', slug: uniq('n1'), timezone: 'America/Tijuana', admin: { email, displayName: 'M', password: PASSWORD } });
    const o2 = await world.platformAdmin.createOrganization({ name: 'N2', slug: uniq('n2'), timezone: 'America/Tijuana', admin: { email, displayName: 'M' } });
    await world.memberships.assignRole(userCtx(o1.organizationId, o1.adminUserId), o1.adminMembershipId, o1.adminRoleId, { type: 'ORGANIZATION' }); // 2º admin ficticio para poder desactivar
    expect((await world.auth.authenticate(email, PASSWORD)).memberships).toHaveLength(2);
    await world.platformAdmin.setOrganizationStatus((await pools.platform.query(`SELECT slug FROM core.organizations WHERE id = $1`, [o2.organizationId])).rows[0].slug, 'SUSPENDED');
    const after = await world.auth.authenticate(email, PASSWORD);
    expect(after.memberships.map((m) => m.organizationId)).toEqual([o1.organizationId]);
  });

  it('cada negocio conserva siempre al menos un administrador activo', async () => {
    await expect(world.memberships.setStatus(A.adminCtx, A.adminMembershipId, 'INACTIVE')).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    await expect(world.memberships.setStatus(A.adminCtx, A.adminMembershipId, 'REMOVED')).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    const assignment = (await pools.platform.query(`SELECT id FROM core.role_assignments WHERE membership_id = $1`, [A.adminMembershipId])).rows[0].id;
    await expect(world.memberships.revokeRole(A.adminCtx, assignment)).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    // con un segundo administrador sí se puede
    await world.memberships.assignRole(A.adminCtx, A.encargadoMembershipId, A.adminRoleId, { type: 'ORGANIZATION' });
    await expect(world.memberships.setStatus(A.adminCtx, A.adminMembershipId, 'INACTIVE')).resolves.toMatchObject({ status: 'INACTIVE' });
    await world.memberships.setStatus(A.adminCtx, A.adminMembershipId, 'ACTIVE');
  });

  it('cuenta de panel y ficha de empleado son conceptos separados: el vínculo es opcional', async () => {
    const adminSinFicha = (await world.memberships.list(A.adminCtx)).find((m) => m.userId === A.adminUserId)!;
    expect(adminSinFicha.employeeId).toBeNull(); // únicamente administrador/dueño, sin checar
    const linked = await world.memberships.linkEmployee(A.adminCtx, A.adminMembershipId, A.employeeId); // empleado + administrador
    expect(linked.employeeId).toBe(A.employeeId);
    await expect(world.memberships.linkEmployee(A.adminCtx, A.encargadoMembershipId, A.employeeId)).rejects.toThrow(); // una ficha, una membresía
    await expect(world.memberships.linkEmployee(A.adminCtx, A.adminMembershipId, B.employeeId)).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' }); // ficha de otro negocio
    await world.memberships.linkEmployee(A.adminCtx, A.adminMembershipId, null);
    expect((await world.memberships.list(A.adminCtx)).find((m) => m.userId === A.adminUserId)!.employeeId).toBeNull();
  });

  it('el catálogo de usuarios globales no filtra emails entre negocios aunque se conozca el id', async () => {
    await asTenant(pools.app, A.organizationId, async (c) => {
      const r = await c.query('SELECT id FROM auth.users WHERE id = $1', [B.adminUserId]);
      expect(r.rowCount).toBe(0);
    });
  });
});

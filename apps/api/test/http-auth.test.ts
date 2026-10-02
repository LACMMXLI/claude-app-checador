import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, startServer, type TestServer } from './helpers/http.js';
import { buildScenario, type Scenario } from './helpers/scenario.js';
import { PASSWORD, buildWorld, openPools } from './helpers/world.js';

const pools = openPools();
const world = buildWorld(pools);
let server: TestServer;
let S: Scenario;

beforeAll(async () => {
  server = await startServer(pools, world);
  S = await buildScenario(world, server);
});
afterAll(async () => {
  await server.close();
  await pools.close();
});

describe('login, sesión por cookie y logout', () => {
  it('la sesión viaja solo en una cookie HttpOnly + SameSite con expiración; el cuerpo nunca trae el token', async () => {
    const a = new Agent(server.baseUrl);
    const r = await a.post('/api/auth/login', { email: S.fatboy.adminEmail, password: PASSWORD });
    expect(r.status).toBe(200);
    const cookie = r.headers.getSetCookie().find((c) => c.startsWith('sid='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=43200/);
    expect(cookie).toMatch(/Path=\//);
    expect(JSON.stringify(r.body)).not.toContain(a.sid!);
    expect(r.body.activeOrganization).toMatchObject({ id: S.fatboy.id, name: 'Fatboy' }); // una sola membresía: entra directo
    expect(r.body.permissions['settings.manage']).toBe('ALL');
  });

  it('en producción la cookie es Secure y usa el prefijo __Host-', async () => {
    const secure = await startServer(pools, world, true);
    try {
      const r = await new Agent(secure.baseUrl).post('/api/auth/login', { email: S.fatboy.adminEmail, password: PASSWORD });
      const cookie = r.headers.getSetCookie()[0]!;
      expect(cookie).toMatch(/^__Host-sid=/);
      expect(cookie).toMatch(/Secure/);
    } finally {
      await secure.close();
    }
  });

  it('credenciales incorrectas ⇒ 401 genérico; sin sesión ⇒ 401', async () => {
    const a = new Agent(server.baseUrl);
    expect((await a.post('/api/auth/login', { email: S.fatboy.adminEmail, password: 'mala-mala-mala' })).body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await a.post('/api/auth/login', { email: 'nadie@x.com', password: 'mala-mala-mala' })).body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await a.get('/api/auth/me')).status).toBe(401);
    expect((await a.get('/api/branches')).status).toBe(401);
  });

  it('el login ROTA la sesión: la cookie anterior deja de servir', async () => {
    const a = await S.login(S.fatboy.adminEmail);
    const first = a.sid!;
    await a.login(S.fatboy.adminEmail, PASSWORD);
    expect(a.sid).not.toBe(first);
    const stale = new Agent(server.baseUrl);
    stale.cookies.set('sid', first);
    expect((await stale.get('/api/auth/me')).status).toBe(401);
  });

  it('logout revoca la sesión en el servidor (la cookie robada ya no sirve)', async () => {
    const a = await S.login(S.fatboy.adminEmail);
    const sid = a.sid!;
    expect((await a.post('/api/auth/logout')).status).toBe(204);
    const thief = new Agent(server.baseUrl);
    thief.cookies.set('sid', sid);
    expect((await thief.get('/api/auth/me')).status).toBe(401);
  });

  it('las peticiones que modifican estado exigen la cabecera anti-CSRF', async () => {
    const a = await S.login(S.fatboy.adminEmail);
    const r = await a.post('/api/branches', { code: 'X1', name: 'X' }, { 'x-requested-with': '' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CSRF_CHECK_FAILED');
  });
});

describe('negocio activo y cambio de negocio', () => {
  it('(8) una identidad con negocios A y B elige negocio tras el login y puede cambiar entre ambos', async () => {
    const a = new Agent(server.baseUrl);
    const login = await a.post('/api/auth/login', { email: S.dualEmail, password: PASSWORD });
    expect(login.body.activeOrganization).toBeNull();
    expect(login.body.memberships.map((m: { organizationId: string }) => m.organizationId).sort()).toEqual([S.fatboy.id, S.pizza.id].sort());
    expect((await a.get('/api/branches')).body.error.code).toBe('NO_ACTIVE_ORGANIZATION');

    const toPizza = await a.post('/api/auth/switch-organization', { organizationId: S.pizza.id });
    expect(toPizza.body.activeOrganization.id).toBe(S.pizza.id);
    expect((await a.get('/api/branches')).body.map((b: { id: string }) => b.id).sort()).toEqual([S.pizza.CEN, S.pizza.NOR].sort());

    const toFatboy = await a.post('/api/auth/switch-organization', { organizationId: S.fatboy.id });
    expect(toFatboy.body.activeOrganization.id).toBe(S.fatboy.id);
    expect((await a.get('/api/branches')).body.map((b: { id: string }) => b.id)).toEqual([S.fatboy.SMA]);
  });

  it('(9) cambiar de negocio rota la sesión y NO conserva permisos del anterior', async () => {
    const a = await S.login(S.dualEmail);
    await a.post('/api/auth/switch-organization', { organizationId: S.pizza.id });
    const pizzaSid = a.sid!;
    expect((await a.get('/api/kiosks')).status).toBe(200); // admin en Pizzería X
    expect((await a.get('/api/auth/me')).body.permissions['kiosks.manage']).toBe('ALL');

    const r = await a.post('/api/auth/switch-organization', { organizationId: S.fatboy.id });
    expect(a.sid).not.toBe(pizzaSid); // identificador nuevo
    expect(r.body.permissions['kiosks.manage']).toBeUndefined();
    expect((await a.get('/api/kiosks')).status).toBe(403); // en Fatboy solo es encargado de San Marcos
    expect((await a.get('/api/members')).status).toBe(403);
    expect((await a.get(`/api/employees/${S.employees.pizza}`)).status).toBe(404); // ni siquiera ve datos de Pizzería X

    const old = new Agent(server.baseUrl);
    old.cookies.set('sid', pizzaSid);
    expect((await old.get('/api/auth/me')).status).toBe(401); // la sesión anterior quedó revocada
  });

  it('no se puede "cambiar" a un negocio sin membresía (ni con un id arbitrario)', async () => {
    const a = await S.login(S.fatboy.adminEmail);
    const before = a.sid;
    const r = await a.post('/api/auth/switch-organization', { organizationId: S.pizza.id });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MEMBERSHIP_NOT_AVAILABLE');
    expect(a.sid).toBe(before);
    expect((await a.get('/api/auth/me')).body.activeOrganization.id).toBe(S.fatboy.id);
  });

  it('(5) una identidad deshabilitada pierde el acceso de inmediato', async () => {
    const a = await S.login(S.managerVenEmail);
    expect((await a.get('/api/branches')).status).toBe(200);
    await pools.platform.query(`UPDATE auth.users SET status = 'DISABLED' WHERE email = $1`, [S.managerVenEmail]);
    try {
      expect((await a.get('/api/branches')).status).toBe(401);
      expect((await new Agent(server.baseUrl).post('/api/auth/login', { email: S.managerVenEmail, password: PASSWORD })).status).toBe(401);
    } finally {
      await pools.platform.query(`UPDATE auth.users SET status = 'ACTIVE' WHERE email = $1`, [S.managerVenEmail]);
    }
  });

  it('(6) una membresía desactivada pierde el acceso SOLO a ese negocio', async () => {
    const dual = await S.login(S.dualEmail);
    await dual.post('/api/auth/switch-organization', { organizationId: S.fatboy.id });
    const admin = await S.login(S.fatboy.adminEmail);
    const member = (await admin.get('/api/members')).body.find((m: { email: string }) => m.email === S.dualEmail);
    expect((await admin.patch(`/api/members/${member.membershipId}/status`, { status: 'INACTIVE', reason: 'Prueba' })).status).toBe(200);
    try {
      expect((await dual.get('/api/branches')).body.error.code).toBe('NO_ACTIVE_ORGANIZATION'); // perdió Fatboy en la sesión viva
      expect((await dual.post('/api/auth/switch-organization', { organizationId: S.fatboy.id })).status).toBe(403);
      expect((await dual.post('/api/auth/switch-organization', { organizationId: S.pizza.id })).status).toBe(200); // Pizzería X intacta
      expect((await dual.get('/api/branches')).status).toBe(200);
    } finally {
      await admin.patch(`/api/members/${member.membershipId}/status`, { status: 'ACTIVE' });
    }
  });

  it('(7) un negocio suspendido impide operar (sesiones vivas y nuevas)', async () => {
    const p = await S.login(S.pizza.adminEmail);
    expect((await p.get('/api/branches')).status).toBe(200);
    await world.platformAdmin.setOrganizationStatus(S.pizza.slug, 'SUSPENDED');
    try {
      expect((await p.get('/api/branches')).body.error.code).toBe('NO_ACTIVE_ORGANIZATION');
      expect((await new Agent(server.baseUrl).post('/api/auth/login', { email: S.pizza.adminEmail, password: PASSWORD })).body.error.code).toBe('NO_ACTIVE_MEMBERSHIP');
      const dual = await S.login(S.dualEmail); // conserva Fatboy y entra directo a él
      expect((await dual.get('/api/auth/me')).body.activeOrganization.id).toBe(S.fatboy.id);
    } finally {
      await world.platformAdmin.setOrganizationStatus(S.pizza.slug, 'ACTIVE');
    }
  });
});

describe('invitaciones (D-11)', () => {
  it('(11) el token de invitación es de un solo uso, se guarda hasheado y la nueva identidad elige su contraseña', async () => {
    const admin = await S.login(S.fatboy.adminEmail);
    const email = `nuevo-${Date.now()}@ejemplo.com`;
    const inv = await admin.post('/api/invitations', { email, roleId: S.fatboy.encargadoRoleId, scope: { type: 'BRANCHES', branchIds: [S.fatboy.AME] } });
    expect(inv.status).toBe(201);
    const token = inv.body.token as string;
    expect((await pools.platform.query(`SELECT count(*)::int AS n FROM core.invitations WHERE token_hash = $1 OR token_hash = $2`, [token, token])).rows[0].n).toBe(0);
    expect(JSON.stringify((await admin.get('/api/invitations')).body)).not.toContain(token);

    const guest = new Agent(server.baseUrl);
    expect((await guest.get(`/api/auth/invitations/${token}`)).body).toMatchObject({ email, userExists: false, organizationName: 'Fatboy' });
    expect((await guest.post(`/api/auth/invitations/${token}/accept`, { password: 'corta' })).body.error.code).toBe('PASSWORD_TOO_SHORT');
    expect((await guest.post(`/api/auth/invitations/${token}/accept`, { password: 'mi-propia-contraseña-1' })).status).toBe(200);
    // segundo uso: rechazado
    expect((await guest.post(`/api/auth/invitations/${token}/accept`, { password: 'otra-contraseña-123' })).status).toBe(410);
    expect((await guest.get(`/api/auth/invitations/${token}`)).status).toBe(410);
    // entra con SU contraseña y solo ve Américas
    await guest.login(email, 'mi-propia-contraseña-1');
    expect((await guest.get('/api/branches')).body.map((b: { id: string }) => b.id)).toEqual([S.fatboy.AME]);
  });

  it('si el correo ya es una identidad global NO se crea otra ni se toca su contraseña: debe probar la suya', async () => {
    const admin = await S.login(S.fatboy.adminEmail);
    const inv = await admin.post('/api/invitations', { email: S.pizza.adminEmail, roleId: S.fatboy.encargadoRoleId, scope: { type: 'BRANCHES', branchIds: [S.fatboy.AME] } });
    const token = inv.body.token as string;
    const guest = new Agent(server.baseUrl);
    expect((await guest.get(`/api/auth/invitations/${token}`)).body.userExists).toBe(true);
    // intentar "fijar" otra contraseña no funciona: se exige la actual
    expect((await guest.post(`/api/auth/invitations/${token}/accept`, { password: 'contraseña-nueva-que-no-es' })).body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await guest.post(`/api/auth/invitations/${token}/accept`, { password: PASSWORD })).body).toMatchObject({ createdUser: false });
    expect((await pools.platform.query(`SELECT count(*)::int AS n FROM auth.users WHERE email = $1`, [S.pizza.adminEmail])).rows[0].n).toBe(1);
    await new Agent(server.baseUrl).login(S.pizza.adminEmail, PASSWORD); // su contraseña sigue igual
  });

  it('una invitación expirada o revocada no sirve; revocar queda auditado', async () => {
    const admin = await S.login(S.fatboy.adminEmail);
    const inv = await admin.post('/api/invitations', { email: `rev-${Date.now()}@ejemplo.com`, roleId: S.fatboy.encargadoRoleId, scope: { type: 'ORGANIZATION' } });
    expect((await admin.post(`/api/invitations/${inv.body.invitationId}/revoke`)).status).toBe(204);
    expect((await new Agent(server.baseUrl).post(`/api/auth/invitations/${inv.body.token}/accept`, { password: 'contraseña-valida-1' })).status).toBe(410);
    const inv2 = await admin.post('/api/invitations', { email: `exp-${Date.now()}@ejemplo.com`, roleId: S.fatboy.encargadoRoleId, scope: { type: 'ORGANIZATION' } });
    await pools.platform.query(`UPDATE core.invitations SET expires_at = now() - interval '1 minute', created_at = now() - interval '2 minutes' WHERE id = $1`, [inv2.body.invitationId]);
    expect((await new Agent(server.baseUrl).post(`/api/auth/invitations/${inv2.body.token}/accept`, { password: 'contraseña-valida-1' })).status).toBe(410);
    const audit = (await admin.get('/api/audit?entityType=invitation')).body.map((r: { action: string }) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['invitation.created', 'invitation.revoked']));
    expect(JSON.stringify((await admin.get('/api/audit?limit=200')).body)).not.toContain(inv.body.token);
  });

  it('un encargado no puede invitar (sin administración global del negocio)', async () => {
    const m = await S.login(S.managerVenEmail);
    const r = await m.post('/api/invitations', { email: 'x@y.com', roleId: S.fatboy.adminRoleId, scope: { type: 'ORGANIZATION' } });
    expect(r.status).toBe(403);
  });
});

describe('(10) credenciales globales', () => {
  it('no existe ninguna ruta para ver/cambiar contraseñas; el admin solo gestiona la membresía', async () => {
    const admin = await S.login(S.fatboy.adminEmail);
    const members = (await admin.get('/api/members')).body;
    expect(JSON.stringify(members)).not.toMatch(/password|argon2|credential/i);
    const target = members.find((m: { email: string }) => m.email === S.managerVenEmail);
    for (const [method, path] of [
      ['PATCH', `/api/members/${target.membershipId}/password`],
      ['POST', `/api/members/${target.membershipId}/password`],
      ['PATCH', `/api/users/${target.userId}`],
      ['POST', `/api/users/${target.userId}/password`],
    ] as const) {
      expect((await admin.request(method, path, { password: 'hackeada-123456' })).status, `${method} ${path}`).toBe(404);
    }
    // aunque lo intente cambiando campos de la membresía, solo cambia el estado
    const r = await admin.patch(`/api/members/${target.membershipId}/status`, { status: 'ACTIVE', password: 'hackeada-123456', email: 'otro@x.com' });
    expect(r.status).toBe(200);
    await new Agent(server.baseUrl).login(S.managerVenEmail, PASSWORD);
    expect((await pools.platform.query(`SELECT count(*)::int AS n FROM auth.users WHERE email = 'otro@x.com'`)).rows[0].n).toBe(0);
  });
});

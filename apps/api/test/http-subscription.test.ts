import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, startServer, type TestServer } from './helpers/http.js';
import { PASSWORD, buildWorld, openPools, uniq } from './helpers/world.js';

/**
 * Fase 5 (D-83, D-86, D-87) · El panel de clientes aplica el plan del negocio por HTTP: límites con código estable,
 * funciones por plan, vista del propio plan y suspensión inmediata.
 */
const pools = openPools();
const world = buildWorld(pools);
let server: TestServer;
beforeAll(async () => {
  server = await startServer(pools, world);
});
afterAll(async () => {
  await server.close();
  await pools.close();
});

async function tenant(plan: 'BASIC' | 'ADVANCED') {
  const slug = uniq('plan');
  const adminEmail = `${slug}@ejemplo.com`;
  const org = await world.platformAdmin.createOrganization({
    name: `Negocio ${slug}`, slug, timezone: 'America/Tijuana',
    branches: [{ code: 'A', name: 'Sucursal A' }],
    admin: { email: adminEmail, displayName: 'Admin', password: PASSWORD },
    subscription: { planCode: plan, status: 'ACTIVE' },
  });
  const admin = new Agent(server.baseUrl);
  await admin.login(adminEmail, PASSWORD);
  return { org, admin, slug, adminEmail, branchA: org.branchIds.A! };
}
const setStatus = (orgId: string, status: string) => pools.platform.query('UPDATE platform.subscriptions SET status = $2 WHERE organization_id = $1', [orgId, status]);
const setPlan = (orgId: string, plan: string) => pools.platform.query('UPDATE platform.subscriptions SET plan_code = $2 WHERE organization_id = $1', [orgId, plan]);

describe('GET /api/subscription (D-87)', () => {
  it('devuelve el plan, estado, límites, funciones y uso del propio negocio, sin datos internos', async () => {
    const t = await tenant('BASIC');
    await pools.platform.query(`UPDATE platform.subscriptions SET notes = 'nota solo para operadores' WHERE organization_id = $1`, [t.org.organizationId]);
    const r = await t.admin.get('/api/subscription');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      planCode: 'BASIC', planName: 'Básico', status: 'ACTIVE',
      limits: { branches: 2, employees: 25, kiosks: 2, members: 3 },
      features: { reportsExport: false, scheduleTemplates: false },
      usage: { branches: 1, employees: 0, kiosks: 0, members: 1, pendingInvitations: 0 },
    });
    expect(JSON.stringify(r.body)).not.toContain('operadores');
    expect(Object.keys(r.body)).not.toContain('notes');
  });

  it('exige sesión y cada negocio ve solo el suyo', async () => {
    const a = await tenant('BASIC');
    const b = await tenant('ADVANCED');
    expect((await new Agent(server.baseUrl).get('/api/subscription')).status).toBe(401);
    expect((await a.admin.get('/api/subscription')).body.planCode).toBe('BASIC');
    expect((await b.admin.get('/api/subscription')).body.planCode).toBe('ADVANCED');
  });
});

describe('funciones por plan (D-83)', () => {
  it('BASIC no exporta reportes ni usa plantillas (403 FEATURE_NOT_IN_PLAN); ADVANCED sí; el cambio de plan aplica de inmediato', async () => {
    const t = await tenant('BASIC');
    const exportBody = { format: 'csv', filters: { report: 'summary', period: 'today' } };
    const denied = await t.admin.post('/api/reports/export', exportBody);
    expect([denied.status, denied.body.error.code, denied.body.error.details.feature]).toEqual([403, 'FEATURE_NOT_IN_PLAN', 'reportsExport']);
    const tpl = await t.admin.get('/api/schedule-templates');
    expect([tpl.status, tpl.body.error.code, tpl.body.error.details.feature]).toEqual([403, 'FEATURE_NOT_IN_PLAN', 'scheduleTemplates']);
    expect((await t.admin.post('/api/schedule-templates', { branchId: t.branchA, name: 'X' })).status).toBe(403);
    // lo demás de BASIC funciona (consultar el reporte en pantalla)
    expect((await t.admin.get('/api/reports/attendance?report=summary&period=today')).status).toBe(200);

    await setPlan(t.org.organizationId, 'ADVANCED');
    expect((await t.admin.raw('POST', '/api/reports/export', exportBody)).status).toBe(200);
    expect((await t.admin.get('/api/schedule-templates')).status).toBe(200);
  });
});

describe('límites de cupo (D-86)', () => {
  it('sucursales: la que excede el plan se rechaza con PLAN_LIMIT_BRANCHES; desactivar libera cupo', async () => {
    const t = await tenant('BASIC'); // 2 sucursales, ya existe A
    expect((await t.admin.post('/api/branches', { code: 'B', name: 'B' })).status).toBe(201);
    const over = await t.admin.post('/api/branches', { code: 'C', name: 'C' });
    expect([over.status, over.body.error.code]).toEqual([403, 'PLAN_LIMIT_BRANCHES']);
    const b = (await t.admin.get('/api/branches')).body.find((x: { code: string }) => x.code === 'B');
    expect((await t.admin.patch(`/api/branches/${b.id}`, { isActive: false, reason: 'cierre' })).status).toBe(200);
    expect((await t.admin.post('/api/branches', { code: 'C', name: 'C' })).status).toBe(201);
    expect((await t.admin.get('/api/subscription')).body.usage.branches).toBe(2);
  });

  it('empleados activos: PLAN_LIMIT_EMPLOYEES al excederse; dar de baja libera y reactivar por encima se rechaza', async () => {
    const t = await tenant('ADVANCED');
    await pools.superuser.query(`INSERT INTO platform.plans (code, name, max_employees, is_active) VALUES ('T_EMP1', 'Prueba', 1, false) ON CONFLICT DO NOTHING`);
    await setPlan(t.org.organizationId, 'T_EMP1');
    const emp = (n: string) => ({ employeeNumber: n, firstName: `Emp${n}`, primaryBranchId: t.branchA });
    const first = await t.admin.post('/api/employees', emp('1'));
    expect(first.status).toBe(201);
    const over = await t.admin.post('/api/employees', emp('2'));
    expect([over.status, over.body.error.code]).toEqual([403, 'PLAN_LIMIT_EMPLOYEES']);
    expect((await t.admin.post(`/api/employees/${first.body.employee.id}/deactivate`, { reason: 'renuncia' })).status).toBe(200);
    const second = await t.admin.post('/api/employees', emp('2'));
    expect(second.status).toBe(201);
    const back = await t.admin.post(`/api/employees/${first.body.employee.id}/reactivate`, {});
    expect([back.status, back.body.error.code]).toEqual([403, 'PLAN_LIMIT_EMPLOYEES']);
  });

  it('kioscos activos: PLAN_LIMIT_KIOSKS', async () => {
    const t = await tenant('BASIC'); // 2 kioscos
    for (const n of ['K1', 'K2']) expect((await t.admin.post('/api/kiosks', { name: n, branchId: t.branchA })).status).toBe(201);
    const over = await t.admin.post('/api/kiosks', { name: 'K3', branchId: t.branchA });
    expect([over.status, over.body.error.code]).toEqual([403, 'PLAN_LIMIT_KIOSKS']);
  });

  it('usuarios: cuentan activos + invitaciones pendientes; el rechazo trae límite y uso; revocar libera lugar', async () => {
    const t = await tenant('BASIC'); // 3 usuarios; el administrador ocupa 1
    const invite = (email: string) => t.admin.post('/api/invitations', { email, roleId: t.org.encargadoRoleId, scope: { type: 'BRANCHES', branchIds: [t.branchA] } });
    const one = await invite(`uno-${t.slug}@ejemplo.com`);
    expect(one.status).toBe(201);
    expect((await invite(`dos-${t.slug}@ejemplo.com`)).status).toBe(201);
    const over = await invite(`tres-${t.slug}@ejemplo.com`);
    expect([over.status, over.body.error.code, over.body.error.details]).toEqual([403, 'PLAN_LIMIT_MEMBERS', { limit: 3, used: 3 }]);
    expect((await t.admin.get('/api/subscription')).body.usage).toMatchObject({ members: 3, pendingInvitations: 2 });
    // revocar una invitación libera el cupo
    expect((await t.admin.post(`/api/invitations/${one.body.invitationId}/revoke`)).status).toBe(204);
    expect((await invite(`tres-${t.slug}@ejemplo.com`)).status).toBe(201);
  });

  it('aceptar una invitación cuando el cupo se llenó entre tanto lo impide PostgreSQL (el alta pública no pasa por el servicio)', async () => {
    const t = await tenant('ADVANCED');
    await pools.superuser.query(`INSERT INTO platform.plans (code, name, max_members, is_active) VALUES ('T_MEM2', 'Prueba', 2, false) ON CONFLICT DO NOTHING`);
    await setPlan(t.org.organizationId, 'T_MEM2');
    const email = `nuevo-${t.slug}@ejemplo.com`;
    const inv = await t.admin.post('/api/invitations', { email, roleId: t.org.encargadoRoleId, scope: { type: 'BRANCHES', branchIds: [t.branchA] } });
    expect(inv.status).toBe(201);
    // mientras tanto la plataforma le da el cupo a otra persona (p. ej. alta directa de un operador)
    const u = (await pools.superuser.query(`INSERT INTO auth.users (email, display_name) VALUES ($1, 'Otra') RETURNING id`, [`otra-${t.slug}@ejemplo.com`])).rows[0].id;
    await pools.platform.query(`INSERT INTO core.organization_memberships (organization_id, user_id) VALUES ($1, $2)`, [t.org.organizationId, u]);
    const accept = await new Agent(server.baseUrl).post(`/api/auth/invitations/${inv.body.token}/accept`, { password: 'clave-larga-segura-1', displayName: 'Nuevo' });
    expect([accept.status, accept.body.error.code]).toEqual([403, 'PLAN_LIMIT_MEMBERS']);
  });
});

describe('suspensión inmediata (D-84)', () => {
  it('suspender la suscripción corta la sesión viva y el inicio de sesión; reanudar lo devuelve, sin perder datos', async () => {
    const t = await tenant('BASIC');
    const created = await t.admin.post('/api/employees', { employeeNumber: '9', firstName: 'Dato', primaryBranchId: t.branchA });
    expect(created.status).toBe(201);
    await setStatus(t.org.organizationId, 'SUSPENDED');
    const cut = await t.admin.get('/api/branches');
    expect([cut.status, cut.body.error.code]).toEqual([409, 'NO_ACTIVE_ORGANIZATION']); // la sesión ya no tiene negocio activo
    const login = await new Agent(server.baseUrl).post('/api/auth/login', { email: t.adminEmail, password: PASSWORD });
    expect([login.status, login.body.error.code]).toEqual([400, 'NO_ACTIVE_MEMBERSHIP']);
    for (const status of ['EXPIRED', 'CANCELLED']) {
      await setStatus(t.org.organizationId, status);
      expect((await new Agent(server.baseUrl).post('/api/auth/login', { email: t.adminEmail, password: PASSWORD })).body.error.code, status).toBe('NO_ACTIVE_MEMBERSHIP');
    }
    await setStatus(t.org.organizationId, 'ACTIVE');
    const again = new Agent(server.baseUrl);
    await again.login(t.adminEmail, PASSWORD);
    expect((await again.get('/api/employees')).body.map((e: { firstName: string }) => e.firstName)).toContain('Dato');
  });
});

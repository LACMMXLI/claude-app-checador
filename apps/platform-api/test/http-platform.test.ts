import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApp } from '../../api/src/app.module.js';
import { createContainer as createTenantContainer } from '../../api/src/container.js';
import { Agent, startServer, type TestServer } from './helpers/http.js';
import { PEPPER, PASSWORD, buildWorld, makeOperator, openPools, uniq } from './helpers/world.js';

/**
 * Consola de plataforma por HTTP (D-81…D-90) y, de punta a punta, su efecto real en la app de clientes: crear un cliente
 * desde la consola, entrar a la app con la contraseña inicial, suspender, reactivar y cambiar de plan.
 */
const pools = openPools();
const world = buildWorld(pools);
let server: TestServer;
let tenantServer: { baseUrl: string; close(): Promise<void> };
let op: Awaited<ReturnType<typeof makeOperator>>;
let console_: Agent;

beforeAll(async () => {
  server = await startServer(pools, world);
  const tenantApp = await createHttpApp({ pool: pools.app, container: createTenantContainer({ appPool: pools.app, pinPepper: PEPPER }), http: { secureCookies: false } }, false);
  await tenantApp.listen(0, '127.0.0.1');
  const { port } = tenantApp.getHttpServer().address() as AddressInfo;
  tenantServer = { baseUrl: `http://127.0.0.1:${port}`, close: () => tenantApp.close() };
  op = await makeOperator(world);
  console_ = new Agent(server.baseUrl);
  await console_.login(op.email, PASSWORD);
});
afterAll(async () => {
  await server.close();
  await tenantServer.close();
  await pools.close();
});

/** Cliente de la app de clientes (otra API, otra cookie, otra cabecera CSRF). */
class TenantAgent extends Agent {
  constructor() { super(tenantServer.baseUrl, 'checador'); }
  override get sid() { return this.cookies.get('sid'); }
}

describe('autenticación y defensas de la consola', () => {
  const ROUTES: [string, string][] = [
    ['GET', '/api/dashboard'], ['GET', '/api/customers'], ['POST', '/api/customers'], ['GET', '/api/customers/00000000-0000-4000-8000-000000000000'],
    ['GET', '/api/customers/00000000-0000-4000-8000-000000000000/history'], ['POST', '/api/customers/00000000-0000-4000-8000-000000000000/subscription/suspend'],
    ['POST', '/api/customers/00000000-0000-4000-8000-000000000000/subscription/activate'], ['PATCH', '/api/customers/00000000-0000-4000-8000-000000000000/subscription/notes'],
    ['GET', '/api/plans'], ['PATCH', '/api/plans/BASIC'], ['GET', '/api/operators'], ['POST', '/api/operators'], ['GET', '/api/audit'],
    ['POST', '/api/support/reset-user-password'], ['GET', '/api/auth/me'], ['POST', '/api/auth/change-password'],
  ];
  it.each(ROUTES)('%s %s exige sesión de operador (401) sin tocar nada', async (method, path) => {
    const r = await new Agent(server.baseUrl).request(method, path, method === 'GET' ? undefined : {});
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('las peticiones que modifican estado exigen X-Requested-With: platform (CSRF) aun con sesión válida', async () => {
    const noCsrf = new Agent(server.baseUrl, null);
    noCsrf.cookies = new Map(console_.cookies);
    expect((await noCsrf.post('/api/customers/00000000-0000-4000-8000-000000000000/subscription/suspend', { reason: 'abc' })).body.error.code).toBe('CSRF_CHECK_FAILED');
    const wrong = new Agent(server.baseUrl, 'checador'); // la cabecera de la app de clientes NO sirve aquí
    wrong.cookies = new Map(console_.cookies);
    expect((await wrong.post('/api/operators', {})).status).toBe(403);
  });

  it('una sesión de un negocio (app de clientes) NO abre la consola, ni al revés', async () => {
    const slug = uniq('cruce');
    const created = await console_.post('/api/customers', {
      name: slug, slug, timezone: 'America/Tijuana', branches: [{ code: 'A', name: 'A' }],
      admin: { email: `${slug}@ejemplo.com`, displayName: 'Dueño' }, subscription: { mode: 'ACTIVE', planCode: 'ADVANCED' },
    });
    expect(created.status).toBe(201);
    const tenant = new TenantAgent();
    await tenant.login(`${slug}@ejemplo.com`, created.body.admin.initialPassword);
    // cookie de la app de clientes presentada a la consola con el nombre de la consola
    const forged = new Agent(server.baseUrl);
    forged.cookies.set('psid', tenant.sid!);
    expect((await forged.get('/api/customers')).status).toBe(401);
    // y un operador no inicia sesión en la app de clientes
    expect((await new TenantAgent().post('/api/auth/login', { email: op.email, password: PASSWORD })).status).toBe(401);
  });

  it('la cookie es HttpOnly + SameSite=Strict; en producción lleva Secure y el prefijo __Host-; el logout la invalida', async () => {
    const secure = await startServer(pools, world, true);
    try {
      const r = await new Agent(secure.baseUrl).post('/api/auth/login', { email: op.email, password: PASSWORD });
      const cookie = r.headers.getSetCookie()[0]!;
      expect(cookie).toMatch(/^__Host-psid=/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).not.toMatch(/Domain=/i);
    } finally {
      await secure.close();
    }
    const plain = new Agent(server.baseUrl);
    await plain.login(op.email, PASSWORD);
    const token = plain.sid!;
    expect((await plain.post('/api/auth/logout')).status).toBe(204);
    const replay = new Agent(server.baseUrl);
    replay.cookies.set('psid', token);
    expect((await replay.get('/api/auth/me')).status).toBe(401);
  });

  it('login: contraseña mala = 401 genérico; validación = 400; /health no requiere sesión', async () => {
    expect((await new Agent(server.baseUrl).post('/api/auth/login', { email: op.email, password: 'mala-mala-mala' })).body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await new Agent(server.baseUrl).post('/api/auth/login', { email: 'no-es-correo', password: 'x' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await new Agent(server.baseUrl).get('/health')).body).toEqual({ status: 'ok' });
    const me = await console_.get('/api/auth/me');
    expect(me.body.operator.email).toBe(op.email);
    expect(JSON.stringify(me.body)).not.toMatch(/password|hash/i);
  });
});

describe('activar cuentas de punta a punta (consola → app de clientes)', () => {
  it('alta → el cliente entra con la contraseña inicial → suspender lo saca → reactivar lo devuelve → el plan manda en sus límites', async () => {
    const slug = uniq('e2e');
    const email = `${slug}@ejemplo.com`;
    const created = await console_.post('/api/customers', {
      name: `Taquería ${slug}`, slug, timezone: 'America/Tijuana', branches: [{ code: 'A', name: 'Centro' }],
      admin: { email, displayName: 'Dueño' }, subscription: { mode: 'TRIAL', planCode: 'BASIC', trialDays: 14 },
    });
    expect(created.status).toBe(201);
    const { organizationId, admin } = created.body;
    expect(admin.initialPassword).toHaveLength(16);

    // el cliente entra a su app y ve su plan
    const tenant = new TenantAgent();
    await tenant.login(email, admin.initialPassword);
    const plan = await tenant.get('/api/subscription');
    expect(plan.body).toMatchObject({ planCode: 'BASIC', status: 'TRIAL', limits: { branches: 2 } });
    expect((await tenant.post('/api/branches', { code: 'B', name: 'B' })).status).toBe(201);
    expect((await tenant.post('/api/branches', { code: 'C', name: 'C' })).body.error.code).toBe('PLAN_LIMIT_BRANCHES');

    // suspender: la sesión viva y el inicio de sesión dejan de funcionar
    const suspended = await console_.post(`/api/customers/${organizationId}/subscription/suspend`, { reason: 'Falta de pago acordada' });
    expect(suspended.status).toBe(200);
    expect(suspended.body.subscription).toMatchObject({ status: 'SUSPENDED', effectiveStatus: 'SUSPENDED' });
    expect((await tenant.get('/api/branches')).status).toBe(409);
    expect((await new TenantAgent().post('/api/auth/login', { email, password: admin.initialPassword })).body.error.code).toBe('NO_ACTIVE_MEMBERSHIP');
    expect((await console_.get(`/api/customers/${organizationId}`)).body).toMatchObject({ organizationStatus: 'SUSPENDED', status: 'SUSPENDED' });

    // reactivar con el plan avanzado: vuelve con todo su historial y sus nuevos límites
    const active = await console_.post(`/api/customers/${organizationId}/subscription/activate`, { planCode: 'ADVANCED' });
    expect(active.body.subscription).toMatchObject({ status: 'ACTIVE', planCode: 'ADVANCED' });
    const again = new TenantAgent();
    await again.login(email, admin.initialPassword);
    expect((await again.get('/api/branches')).body.map((b: { code: string }) => b.code).sort()).toEqual(['A', 'B']);
    expect((await again.post('/api/branches', { code: 'C', name: 'C' })).status).toBe(201);
    expect((await again.get('/api/subscription')).body).toMatchObject({ planCode: 'ADVANCED', features: { reportsExport: true } });

    // bajar de plan no borra nada y lo avisa
    const down = await console_.post(`/api/customers/${organizationId}/subscription/change-plan`, { planCode: 'BASIC' });
    expect(down.body.warnings).toEqual([{ resource: 'branches', limit: 2, used: 3 }]);
    expect((await again.get('/api/branches')).body).toHaveLength(3);

    // historial y bitácora de la consola
    const history = await console_.get(`/api/customers/${organizationId}/history`);
    expect(history.body.events.map((e: { event: string }) => e.event)).toEqual(expect.arrayContaining(['CREATED', 'STATUS_CHANGED', 'PLAN_CHANGED']));
    expect(history.body.events.every((e: { actor: string }) => e.actor === `operator:${op.email}` || e.actor === 'system')).toBe(true);
    expect(history.body.audit.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['subscription.suspended', 'subscription.activated', 'subscription.plan_changed', 'organization.created']));
    expect(JSON.stringify(history.body)).not.toContain(admin.initialPassword);
  });

  it('errores con códigos estables: 404 de cliente, 409 de estado, 400 de validación, 422 de límite del plan', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await console_.get(`/api/customers/${missing}`)).body.error.code).toBe('CUSTOMER_NOT_FOUND');
    expect((await console_.get('/api/customers/no-es-uuid')).status).toBe(400);
    expect((await console_.post(`/api/customers/${missing}/subscription/suspend`, { reason: 'abc' })).status).toBe(404);
    const slug = uniq('err');
    const base = { name: slug, slug, timezone: 'America/Tijuana', admin: { email: `${slug}@ejemplo.com`, displayName: 'D' } };
    const over = await console_.post('/api/customers', { ...base, branches: [{ code: 'A', name: 'A' }, { code: 'B', name: 'B' }, { code: 'C', name: 'C' }], subscription: { mode: 'ACTIVE', planCode: 'BASIC' } });
    expect([over.status, over.body.error.code]).toEqual([422, 'PLAN_LIMIT_BRANCHES']);
    expect((await console_.post('/api/customers', { ...base, branches: [{ code: 'A', name: 'A' }], subscription: { mode: 'TRIAL', planCode: 'BASIC', trialDays: 0 } })).status).toBe(400);
    const ok = await console_.post('/api/customers', { ...base, branches: [{ code: 'A', name: 'A' }], subscription: { mode: 'ACTIVE', planCode: 'BASIC' } });
    expect(ok.status).toBe(201);
    expect((await console_.post('/api/customers', { ...base, branches: [{ code: 'A', name: 'A' }], subscription: { mode: 'ACTIVE', planCode: 'BASIC' } })).body.error.code).toBe('ORGANIZATION_SLUG_TAKEN');
    const sus = await console_.post(`/api/customers/${ok.body.organizationId}/subscription/suspend`, { reason: 'motivo' });
    expect(sus.status).toBe(200);
    expect((await console_.post(`/api/customers/${ok.body.organizationId}/subscription/suspend`, { reason: 'motivo' })).status).toBe(409);
    expect((await console_.post(`/api/customers/${ok.body.organizationId}/subscription/extend`, { until: '2999-01-01' })).status).toBe(409);
    expect((await console_.post(`/api/customers/${ok.body.organizationId}/subscription/suspend`, {})).status).toBe(400);
  });
});

describe('planes, operadores, bitácora y soporte por HTTP', () => {
  it('lista y edita planes (validado); crea operadores (contraseña una vez); la bitácora los registra', async () => {
    const plans = await console_.get('/api/plans');
    expect(plans.body.map((p: { code: string }) => p.code)).toEqual(expect.arrayContaining(['BASIC', 'ADVANCED']));
    expect((await console_.patch('/api/plans/BASIC', { limits: { kiosks: -1 } })).status).toBe(400);
    expect((await console_.patch('/api/plans/BASIC', { description: 'Plan de entrada' })).body.description).toBe('Plan de entrada');

    const email = `${uniq('nuevo')}@plataforma.example`;
    const created = await console_.post('/api/operators', { email, displayName: 'Nuevo Operador' });
    expect(created.status).toBe(201);
    expect(created.body.initialPassword).toHaveLength(16);
    expect(created.body.operator).not.toHaveProperty('passwordHash');
    const list = await console_.get('/api/operators');
    expect(list.body.find((o: { email: string }) => o.email === email)).toBeTruthy();
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|password_hash|argon2/);
    expect((await console_.post(`/api/operators/${op.id}/status`, { status: 'DISABLED' })).body.error.code).toBe('CANNOT_DISABLE_SELF');

    const audit = await console_.get('/api/audit?limit=100');
    expect(audit.body.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['operator.created', 'plan.updated']));
    expect(JSON.stringify(audit.body)).not.toContain(created.body.initialPassword);
  });

  it('cambiar la propia contraseña y restablecer la de una persona de un cliente', async () => {
    const mine = new Agent(server.baseUrl);
    const other = await makeOperator(world);
    await mine.login(other.email, PASSWORD);
    expect((await mine.post('/api/auth/change-password', { currentPassword: 'no-es', newPassword: 'nueva-clave-larga-1' })).status).toBe(403);
    expect((await mine.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'nueva-clave-larga-1' })).status).toBe(204);
    expect((await new Agent(server.baseUrl).post('/api/auth/login', { email: other.email, password: 'nueva-clave-larga-1' })).status).toBe(200);

    const slug = uniq('soporte');
    await console_.post('/api/customers', { name: slug, slug, timezone: 'America/Tijuana', branches: [{ code: 'A', name: 'A' }], admin: { email: `${slug}@ejemplo.com`, displayName: 'D', password: PASSWORD }, subscription: { mode: 'ACTIVE', planCode: 'ADVANCED' } });
    const reset = await console_.post('/api/support/reset-user-password', { email: `${slug}@ejemplo.com` });
    expect(reset.status).toBe(200);
    const tenant = new TenantAgent();
    expect((await tenant.post('/api/auth/login', { email: `${slug}@ejemplo.com`, password: PASSWORD })).status).toBe(401);
    await tenant.login(`${slug}@ejemplo.com`, reset.body.password);
    expect((await console_.post('/api/support/reset-user-password', { email: 'nadie@ejemplo.com' })).status).toBe(404);
  });
});

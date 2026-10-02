import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainer } from '../src/container.js';
import { AccessProfile } from '../src/modules/auth/rbac.service.js';
import { PEPPER } from './helpers/config.js';
import { Agent, startServer, type TestServer } from './helpers/http.js';
import { buildScenario, type Scenario } from './helpers/scenario.js';
import { buildWorld, openPools } from './helpers/world.js';

const pools = openPools();
const world = buildWorld(pools);
let server: TestServer;
let S: Scenario;
let fAdmin: Agent;
let pAdmin: Agent;
let manager: Agent;

beforeAll(async () => {
  server = await startServer(pools, world);
  S = await buildScenario(world, server);
  fAdmin = await S.login(S.fatboy.adminEmail);
  pAdmin = await S.login(S.pizza.adminEmail);
  manager = await S.login(S.managerVenEmail);
});
afterAll(async () => {
  await server.close();
  await pools.close();
});

const ids = (r: { body: { id: string }[] }) => r.body.map((x) => x.id).sort();

describe('(1) aislamiento entre negocios en los endpoints', () => {
  it('un usuario del negocio A no puede consultar ni modificar recursos del B, aunque conozca sus ids', async () => {
    expect(ids(await fAdmin.get('/api/branches'))).toEqual([S.fatboy.VEN, S.fatboy.SMA, S.fatboy.AME].sort());
    expect((await fAdmin.get(`/api/branches/${S.pizza.CEN}`)).status).toBe(404);
    expect((await fAdmin.patch(`/api/branches/${S.pizza.CEN}`, { name: 'Hackeada' })).status).toBe(404);
    expect((await fAdmin.get(`/api/employees/${S.employees.pizza}`)).status).toBe(404);
    expect((await fAdmin.patch(`/api/employees/${S.employees.pizza}`, { firstName: 'X' })).status).toBe(404);
    expect((await fAdmin.post(`/api/employees/${S.employees.pizza}/pin`)).status).toBe(404);
    expect((await fAdmin.get('/api/employees')).body.map((e: { id: string }) => e.id)).not.toContain(S.employees.pizza);
    expect((await fAdmin.get(`/api/policies/effective?employeeId=${S.employees.pizza}`)).body.find((p: { key: string }) => p.key === 'breakAllowedMin').levels.EMPLOYEE).toBeNull();
    expect((await fAdmin.put('/api/policies/override', { scope: 'BRANCH', targetId: S.pizza.CEN, values: { breakAllowedMin: 1 } })).status).toBe(404);
    expect((await fAdmin.post('/api/kiosks', { name: 'Intruso', branchId: S.pizza.CEN })).status).toBe(404);
    const audit = (await fAdmin.get('/api/audit?limit=200')).body as { organizationId: string }[];
    expect(new Set(audit.map((a) => a.organizationId))).toEqual(new Set([S.fatboy.id]));
    const pizzaName = await pools.platform.query(`SELECT name FROM core.branches WHERE id = $1`, [S.pizza.CEN]);
    expect(pizzaName.rows[0].name).toBe('Centro');
  });
});

describe('(2) alterar organization_id en la petición NO cambia el tenant', () => {
  it('se ignora en query, body y cabeceras: el negocio sale SOLO de la sesión', async () => {
    const h = { 'x-organization-id': S.pizza.id, 'x-tenant-id': S.pizza.id };
    expect(ids(await fAdmin.get(`/api/branches?organizationId=${S.pizza.id}&organization_id=${S.pizza.id}`, h))).toEqual([S.fatboy.VEN, S.fatboy.SMA, S.fatboy.AME].sort());
    const created = await fAdmin.post('/api/branches', { code: `T${Date.now() % 100000}`, name: 'Creada', organizationId: S.pizza.id, organization_id: S.pizza.id }, h);
    expect(created.status).toBe(201);
    expect(created.body.organizationId).toBe(S.fatboy.id);
    const emp = await fAdmin.post('/api/employees', { employeeNumber: `X-${Date.now()}`, firstName: 'Tenant', primaryBranchId: S.fatboy.VEN, organizationId: S.pizza.id });
    expect(emp.status).toBe(201);
    expect(emp.body.employee.organizationId).toBe(S.fatboy.id);
    const pol = await fAdmin.put('/api/policies/override', { scope: 'ORGANIZATION', values: { entryToleranceMin: 7 }, organizationId: S.pizza.id });
    expect(pol.status).toBe(200);
    const pizzaPolicies = (await pAdmin.get('/api/policies/effective')).body.find((p: { key: string }) => p.key === 'entryToleranceMin');
    expect(pizzaPolicies).toMatchObject({ effective: 10, source: 'PLATFORM' });
    // ni falsificando la cookie con un formato distinto
    const forged = new Agent(server.baseUrl);
    forged.cookies.set('sid', S.pizza.id);
    expect((await forged.get('/api/branches')).status).toBe(401);
  });
});

describe('(3)(4) RBAC por sucursal en el backend', () => {
  it('(3) el encargado de Venecia NO puede administrar San Marcos', async () => {
    expect(ids(await manager.get('/api/branches'))).toEqual([S.fatboy.VEN]);
    expect((await manager.get(`/api/branches/${S.fatboy.SMA}`)).status).toBe(404);
    const visible = (await manager.get('/api/employees')).body as { id: string; branchIds: string[] }[];
    expect(visible.map((e) => e.id)).toContain(S.employees.ven);
    expect(visible.map((e) => e.id)).not.toContain(S.employees.sma);
    expect(visible.every((e) => e.branchIds.includes(S.fatboy.VEN))).toBe(true);
    expect((await manager.get(`/api/employees/${S.employees.sma}`)).status).toBe(404);
    expect((await manager.patch(`/api/employees/${S.employees.sma}`, { firstName: 'X' })).status).toBe(404);
    expect((await manager.post(`/api/employees/${S.employees.sma}/pin`)).status).toBe(404);
    expect((await manager.post('/api/employees', { employeeNumber: 'M-1', firstName: 'X', primaryBranchId: S.fatboy.SMA })).status).toBe(403);
    expect((await manager.post(`/api/employees/${S.employees.ven}/assignments`, { branchId: S.fatboy.SMA, kind: 'TEMPORARY', validFrom: '2031-01-01', validTo: '2031-01-02', reason: 'x' })).status).toBe(403);
  });

  it('el encargado SÍ opera su sucursal (empleados y PIN), sin administración global ni credenciales', async () => {
    expect((await manager.patch(`/api/employees/${S.employees.ven}`, { phone: '6640000000' })).status).toBe(200);
    const created = await manager.post('/api/employees', { employeeNumber: `MV-${Date.now()}`, firstName: 'Nuevo', primaryBranchId: S.fatboy.VEN });
    expect(created.status).toBe(201);
    expect(created.body.pin).toMatch(/^\d{6}$/);
    for (const [method, path] of [
      ['POST', '/api/branches'], ['PATCH', `/api/branches/${S.fatboy.VEN}`], ['GET', '/api/members'], ['GET', '/api/invitations'],
      ['GET', '/api/kiosks'], ['POST', '/api/kiosks'], ['GET', '/api/policies/effective'], ['PUT', '/api/policies/override'],
      ['GET', '/api/audit'], ['GET', '/api/roles'],
    ] as const) {
      expect((await manager.request(method, path, method === 'GET' ? undefined : { code: 'Z', name: 'Z', branchId: S.fatboy.VEN, scope: 'ORGANIZATION', values: {} })).status, `${method} ${path}`).toBe(403);
    }
  });

  it('(4) el admin trabaja con TODAS las sucursales de su negocio', async () => {
    for (const b of [S.fatboy.VEN, S.fatboy.SMA, S.fatboy.AME]) {
      expect((await fAdmin.get(`/api/branches/${b}`)).status).toBe(200);
      expect((await fAdmin.post('/api/kiosks', { name: `K-${b.slice(0, 4)}`, branchId: b })).status).toBe(201);
    }
    expect((await fAdmin.patch(`/api/employees/${S.employees.sma}`, { lastName: 'Editado' })).status).toBe(200);
    expect((await fAdmin.get('/api/employees')).body.map((e: { id: string }) => e.id)).toEqual(expect.arrayContaining([S.employees.ven, S.employees.sma]));
    expect((await fAdmin.get('/api/members')).status).toBe(200);
    expect((await fAdmin.get('/api/audit')).status).toBe(200);
  });
});

describe('administración base', () => {
  it('sucursales: crear, editar, zona horaria opcional (hereda/override) y desactivar sin borrar', async () => {
    const r = await fAdmin.post('/api/branches', { code: `NUE${Date.now() % 10000}`, name: 'Nueva' });
    expect(r.body).toMatchObject({ timezone: null, isActive: true });
    const id = r.body.id as string;
    expect((await fAdmin.get(`/api/branches/${id}`)).body.effectiveTimezone).toBe('America/Tijuana');
    expect((await fAdmin.patch(`/api/branches/${id}`, { timezone: 'America/Mexico_City' })).body.timezone).toBe('America/Mexico_City');
    expect((await fAdmin.get(`/api/branches/${id}`)).body.effectiveTimezone).toBe('America/Mexico_City');
    expect((await fAdmin.patch(`/api/branches/${id}`, { timezone: null })).body.timezone).toBeNull();
    expect((await fAdmin.patch(`/api/branches/${id}`, { timezone: 'Nope/Nada' })).body.error.code).toBe('TIMEZONE_INVALID');
    expect((await fAdmin.patch(`/api/branches/${id}`, { isActive: false, reason: 'Cierre temporal' })).body.isActive).toBe(false);
    expect((await fAdmin.request('DELETE', `/api/branches/${id}`)).status).toBe(404); // no existe borrado
    expect((await pools.platform.query(`SELECT count(*)::int AS n FROM core.branches WHERE id = $1`, [id])).rows[0].n).toBe(1);
  });

  it('empleados: alta con PIN único visible una vez, edición, baja/reingreso y asignaciones', async () => {
    const r = await fAdmin.post('/api/employees', { employeeNumber: `E-${Date.now()}`, firstName: 'Ana', primaryBranchId: S.fatboy.AME });
    expect(r.status).toBe(201);
    const id = r.body.employee.id as string;
    expect(JSON.stringify((await fAdmin.get(`/api/employees/${id}`)).body)).not.toContain(r.body.pin);
    expect((await fAdmin.get(`/api/employees/${id}`)).body).toMatchObject({ hasPin: true, primaryBranchId: S.fatboy.AME });
    expect((await fAdmin.post(`/api/employees/${id}/deactivate`, {})).body.error.code).toBe('VALIDATION_ERROR');
    expect((await fAdmin.post(`/api/employees/${id}/deactivate`, { reason: 'Renuncia' })).body.status).toBe('INACTIVE');
    const back = await fAdmin.post(`/api/employees/${id}/reactivate`, { reason: 'Reingreso' });
    expect(back.body.pin).toMatch(/^\d{6}$/);
    const temp = await fAdmin.post(`/api/employees/${id}/assignments`, { branchId: S.fatboy.VEN, kind: 'TEMPORARY', validFrom: '2031-02-01', validTo: '2031-02-10', reason: 'Cubre' });
    expect(temp.status).toBe(201);
  });

  it('(13) el PIN anterior deja de funcionar al restablecerlo (vía kiosco real)', async () => {
    const kiosk = await fAdmin.post('/api/kiosks', { name: 'Barra Venecia', branchId: S.fatboy.VEN });
    const token = kiosk.body.token as string;
    const device = new Agent(server.baseUrl);
    const identify = (pin: string) => device.post('/api/kiosk/identify', { pin }, { authorization: `Bearer ${token}`, 'x-requested-with': '' });
    expect((await identify(S.pins.ven)).body.employee.id).toBe(S.employees.ven);
    const reset = await manager.post(`/api/employees/${S.employees.ven}/pin`, { reason: 'Lo compartió' });
    expect(reset.status).toBe(200);
    expect((await identify(S.pins.ven)).status).toBe(401);
    expect((await identify(reset.body.pin)).body.employee.id).toBe(S.employees.ven);
    S.pins.ven = reset.body.pin;
  });

  it('políticas: override guardado vs política efectiva con su ORIGEN (35 → 30 por empleado)', async () => {
    await fAdmin.put('/api/policies/override', { scope: 'ORGANIZATION', values: { breakAllowedMin: 35 } });
    await fAdmin.put('/api/policies/override', { scope: 'EMPLOYEE', targetId: S.employees.ven, values: { breakAllowedMin: 30 } });
    const stored = await fAdmin.get(`/api/policies/override?scope=EMPLOYEE&targetId=${S.employees.ven}`);
    expect(stored.body).toEqual({ breakAllowedMin: 30 }); // solo lo sobrescrito
    const eff = (await fAdmin.get(`/api/policies/effective?branchId=${S.fatboy.VEN}&employeeId=${S.employees.ven}`)).body;
    expect(eff.find((p: { key: string }) => p.key === 'breakAllowedMin')).toMatchObject({
      effective: 30, source: 'EMPLOYEE', levels: { PLATFORM: 35, ORGANIZATION: 35, BRANCH: null, EMPLOYEE: 30 },
    });
    expect(eff.find((p: { key: string }) => p.key === 'pinLockoutMaxSec')).toMatchObject({ effective: 120, source: 'PLATFORM' });
    const invalid = await fAdmin.put('/api/policies/override', { scope: 'EMPLOYEE', targetId: S.employees.ven, values: { operationalCutoff: '06:00' } });
    expect(invalid.body.error.code).toBe('POLICY_SCOPE_NOT_ALLOWED');
  });
});

describe('kioscos', () => {
  it('(12) crear → token visible una vez; revocar lo invalida; regenerar emite otro; desactivar bloquea', async () => {
    const created = await fAdmin.post('/api/kiosks', { name: 'Caja Américas', branchId: S.fatboy.AME });
    const id = created.body.device.id as string;
    const token1 = created.body.token as string;
    expect(token1).toMatch(/^kt_/);
    const list = (await fAdmin.get('/api/kiosks')).body;
    expect(JSON.stringify(list)).not.toContain(token1.split('.')[1]);
    expect(list.find((k: { id: string }) => k.id === id)).toMatchObject({ hasToken: true, status: 'ACTIVE', branchId: S.fatboy.AME });

    const device = (token: string) => new Agent(server.baseUrl).post('/api/kiosk/identify', { pin: '000000' }, { authorization: `Bearer ${token}` });
    expect((await device(token1)).body.error.code).toBe('INVALID_PIN'); // token válido (el PIN no)

    expect((await fAdmin.post(`/api/kiosks/${id}/token/revoke`, { reason: 'Robada' })).body.hasToken).toBe(false);
    expect((await device(token1)).body.error.code).toBe('KIOSK_TOKEN_INVALID');

    const token2 = (await fAdmin.post(`/api/kiosks/${id}/token`)).body.token as string;
    expect(token2).not.toBe(token1);
    expect((await device(token2)).body.error.code).toBe('INVALID_PIN');
    const token3 = (await fAdmin.post(`/api/kiosks/${id}/token`)).body.token as string;
    expect((await device(token2)).body.error.code).toBe('KIOSK_TOKEN_INVALID'); // regenerar invalida el anterior

    await fAdmin.post(`/api/kiosks/${id}/status`, { status: 'INACTIVE' });
    expect((await device(token3)).body.error.code).toBe('KIOSK_TOKEN_INVALID');
    await fAdmin.post(`/api/kiosks/${id}/status`, { status: 'ACTIVE' });
    expect((await device(token3)).body.error.code).toBe('INVALID_PIN');

    expect((await fAdmin.patch(`/api/kiosks/${id}`, { branchId: S.fatboy.VEN })).body.branchId).toBe(S.fatboy.VEN);
    expect((await fAdmin.get('/api/kiosks')).body.find((k: { id: string }) => k.id === id).lastSeenAt).not.toBeNull();
  });
});

describe('(14) RLS como última capa', () => {
  it('aunque la autorización de la API fallara (RBAC "todo permitido"), PostgreSQL no entrega datos de otro negocio', async () => {
    const container = createContainer({ appPool: pools.app, pinPepper: PEPPER });
    // Simulamos un bug grave: el RBAC concede TODO en TODAS las sucursales
    container.rbac.loadAccess = async () => new AccessProfile([{ permissions: new Set((await pools.platform.query('SELECT code FROM core.permissions')).rows.map((r) => r.code)), branchIds: null }]);
    const buggy = await startServer(pools, container);
    try {
      const m = new Agent(buggy.baseUrl);
      await m.login(S.managerVenEmail, 'una-contraseña-segura-123');
      // con el RBAC roto ve TODO Fatboy (falla de la capa de aplicación)…
      expect((await m.get('/api/branches')).body.length).toBeGreaterThanOrEqual(3);
      // …pero NADA de Pizzería X: la base de datos lo impide
      expect((await m.get(`/api/branches/${S.pizza.CEN}`)).status).toBe(404);
      expect((await m.get(`/api/employees/${S.employees.pizza}`)).status).toBe(404);
      expect((await m.patch(`/api/employees/${S.employees.pizza}`, { firstName: 'X' })).status).toBe(404);
      expect((await m.post('/api/kiosks', { name: 'X', branchId: S.pizza.CEN })).status).toBe(404);
      expect((await m.get('/api/employees')).body.map((e: { organizationId: string }) => e.organizationId).every((o: string) => o === S.fatboy.id)).toBe(true);
      expect((await m.get('/api/audit?limit=200')).body.every((a: { organizationId: string }) => a.organizationId === S.fatboy.id)).toBe(true);
    } finally {
      await buggy.close();
    }
  });

  it('el pool de la API es app_user sin BYPASSRLS mientras atiende peticiones', async () => {
    const { rows } = await pools.app.query(`SELECT current_user AS u, rolbypassrls AS b FROM pg_roles WHERE rolname = current_user`);
    expect(rows[0]).toEqual({ u: 'app_user', b: false });
  });
});

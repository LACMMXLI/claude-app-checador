import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ageOn, isoWeekday } from '../src/common/time.js';
import { Agent, startServer, type TestServer } from './helpers/http.js';
import { PASSWORD, buildWorld, openPools, uniq } from './helpers/world.js';

/**
 * D-92 · Días de descanso semanales y fecha de nacimiento: validación en API y en PostgreSQL, edad calculada,
 * auditoría y la vista semanal del horario con descansos y edad (sin exponer la fecha de nacimiento).
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

async function tenant() {
  const slug = uniq('desc');
  const adminEmail = `${slug}@ejemplo.com`;
  const org = await world.platformAdmin.createOrganization({
    name: `Negocio ${slug}`, slug, timezone: 'America/Tijuana',
    branches: [{ code: 'A', name: 'Sucursal A' }],
    admin: { email: adminEmail, displayName: 'Admin', password: PASSWORD },
    subscription: { planCode: 'ADVANCED', status: 'ACTIVE' },
  });
  const admin = new Agent(server.baseUrl);
  await admin.login(adminEmail, PASSWORD);
  return { org, admin, branchA: org.branchIds.A! };
}
const emp = (t: { branchA: string }, n: string, extra: Record<string, unknown> = {}) => ({ employeeNumber: n, firstName: `Emp${n}`, primaryBranchId: t.branchA, ...extra });

describe('helpers de fecha', () => {
  it('ageOn cuenta años cumplidos y isoWeekday va de lunes=1 a domingo=7', () => {
    expect(ageOn('2000-10-05', '2026-10-05')).toBe(26);
    expect(ageOn('2000-10-06', '2026-10-05')).toBe(25);
    expect(ageOn('2000-02-29', '2026-02-28')).toBe(25);
    expect(ageOn('2000-02-29', '2026-03-01')).toBe(26);
    expect(ageOn(null, '2026-10-05')).toBeNull();
    expect(ageOn('2030-01-01', '2026-10-05')).toBeNull();
    expect([isoWeekday('2026-10-05'), isoWeekday('2026-10-11')]).toEqual([1, 7]); // lunes, domingo
  });
});

describe('alta y edición (D-92)', () => {
  it('guarda los días de descanso ordenados y sin repetidos, y la edad se calcula', async () => {
    const t = await tenant();
    const created = await t.admin.post('/api/employees', emp(t, '1', { restDays: [7, 3, 3], birthDate: '1990-01-15' }));
    expect(created.status).toBe(201);
    expect(created.body.employee.restDays).toEqual([3, 7]);
    const got = (await t.admin.get(`/api/employees/${created.body.employee.id}`)).body;
    expect([got.restDays, got.birthDate]).toEqual([[3, 7], '1990-01-15']);
    expect(got.age).toBe(ageOn('1990-01-15', new Date().toISOString().slice(0, 10)));
    const list = (await t.admin.get('/api/employees')).body.find((e: { id: string }) => e.id === created.body.employee.id);
    expect(list.age).toBe(got.age);
    // sin datos: sin descanso fijo y sin edad
    const bare = await t.admin.post('/api/employees', emp(t, '2'));
    expect([bare.body.employee.restDays, bare.body.employee.birthDate]).toEqual([[], null]);
    expect((await t.admin.get(`/api/employees/${bare.body.employee.id}`)).body.age).toBeNull();
  });

  it('PATCH cambia o limpia los descansos y la fecha, y la bitácora guarda antes y después', async () => {
    const t = await tenant();
    const id = (await t.admin.post('/api/employees', emp(t, '1', { restDays: [1] }))).body.employee.id;
    const upd = await t.admin.patch(`/api/employees/${id}`, { restDays: [6, 7], birthDate: '1985-05-20', reason: 'acuerdo' });
    expect(upd.status).toBe(200);
    expect([upd.body.restDays, upd.body.birthDate]).toEqual([[6, 7], '1985-05-20']);
    const audit = await pools.superuser.query(
      `SELECT before, after FROM audit.audit_log WHERE organization_id = $1 AND action = 'employee.updated' AND entity_id = $2`, [t.org.organizationId, id]);
    expect(audit.rows).toHaveLength(1);
    expect([audit.rows[0].before.restDays, audit.rows[0].after.restDays]).toEqual([[1], [6, 7]]);
    const cleared = await t.admin.patch(`/api/employees/${id}`, { restDays: [], birthDate: null });
    expect([cleared.body.restDays, cleared.body.birthDate]).toEqual([[], null]);
  });

  it('rechaza días fuera de 1..7, los 7 días y fechas de nacimiento imposibles (API y base de datos)', async () => {
    const t = await tenant();
    for (const restDays of [[0], [8], [1, 2, 3, 4, 5, 6, 7], ['lunes']]) {
      const r = await t.admin.post('/api/employees', emp(t, `x${JSON.stringify(restDays)}`, { restDays }));
      expect([r.status, r.body.error.code], JSON.stringify(restDays)).toEqual([400, 'VALIDATION_ERROR']);
    }
    for (const birthDate of ['2999-01-01', '1800-01-01', '15/01/1990', '2026-02-31']) {
      const r = await t.admin.post('/api/employees', emp(t, `b${birthDate}`, { birthDate }));
      expect(r.status, birthDate).toBe(400);
    }
    // última línea de defensa: PostgreSQL, saltándose la API
    const org = t.org.organizationId;
    const sql = (extra: string, vals: unknown[]) => pools.superuser.query(`INSERT INTO core.employees (organization_id, employee_number, first_name, ${extra}) VALUES ($1, 'sql-' || gen_random_uuid()::text, 'X', $2)`, [org, ...vals]);
    await expect(sql('rest_days', [[1, 1]])).rejects.toMatchObject({ code: '23514' });
    await expect(sql('rest_days', [[9]])).rejects.toMatchObject({ code: '23514' });
    await expect(sql('rest_days', [[1, 2, 3, 4, 5, 6, 7]])).rejects.toMatchObject({ code: '23514' });
    await expect(sql('rest_days', [null])).rejects.toMatchObject({ code: '23502' });
    await expect(sql('birth_date', ['2999-01-01'])).rejects.toMatchObject({ code: '23514' });
    await expect(sql('birth_date', ['1850-01-01'])).rejects.toMatchObject({ code: '23514' });
    await expect(sql('rest_days', [[2, 5]])).resolves.toBeTruthy();
  });

  it('sin el permiso employees.manage no se pueden cambiar (el encargado de otra sucursal no ve al empleado)', async () => {
    const t = await tenant();
    const id = (await t.admin.post('/api/employees', emp(t, '1', { restDays: [2] }))).body.employee.id;
    const anon = new Agent(server.baseUrl);
    expect((await anon.patch(`/api/employees/${id}`, { restDays: [3] })).status).toBe(401);
    const other = await tenant(); // otro negocio: aislamiento
    expect((await other.admin.patch(`/api/employees/${id}`, { restDays: [3] })).status).toBe(404);
    expect((await t.admin.get(`/api/employees/${id}`)).body.restDays).toEqual([2]);
  });
});

describe('vista semanal del horario con descansos y edad', () => {
  it('cada empleado trae sus días de descanso y su edad, nunca la fecha de nacimiento', async () => {
    const t = await tenant();
    await t.admin.post('/api/employees', emp(t, '1', { restDays: [2, 4], birthDate: '1995-03-10' }));
    await t.admin.post('/api/employees', emp(t, '2'));
    const week = await t.admin.get(`/api/schedules/week?branchId=${t.branchA}&date=2026-10-15`);
    expect(week.status).toBe(200);
    const [one, two] = ['Emp1', 'Emp2'].map((n) => week.body.employees.find((e: { firstName: string }) => e.firstName === n));
    expect(one.restDays).toEqual([2, 4]);
    expect(one.age).toBe(ageOn('1995-03-10', new Date().toISOString().slice(0, 10)));
    expect([two.restDays, two.age]).toEqual([[], null]);
    expect(JSON.stringify(week.body)).not.toContain('1995-03-10');
    expect(Object.keys(one)).not.toContain('birthDate');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainer } from '../src/container.js';
import { AccessProfile } from '../src/modules/auth/rbac.service.js';
import { PEPPER } from './helpers/config.js';
import { Agent, startServer, type TestServer } from './helpers/http.js';
import { buildScenario, type Scenario } from './helpers/scenario.js';
import { PASSWORD, buildWorld, openPools } from './helpers/world.js';

const pools = openPools();
const world = buildWorld(pools);
let server: TestServer;
let S: Scenario;
let fAdmin: Agent;
let pAdmin: Agent;
let manager: Agent;
let pizzaShift: { id: string; version: number };

beforeAll(async () => {
  server = await startServer(pools, world);
  S = await buildScenario(world, server);
  fAdmin = await S.login(S.fatboy.adminEmail);
  pAdmin = await S.login(S.pizza.adminEmail);
  manager = await S.login(S.managerVenEmail);
  const r = await pAdmin.post('/api/shifts', { branchId: S.pizza.CEN, employeeId: S.employees.pizza, date: '2026-10-13', startTime: '09:00', endTime: '17:00' });
  expect(r.status).toBe(201);
  pizzaShift = r.body;
});
afterAll(async () => {
  await server.close();
  await pools.close();
});

const body = (employeeId: string, branchId: string, date: string, startTime: string, endTime: string, extra: object = {}) => ({ employeeId, branchId, date, startTime, endTime, ...extra });

describe('horario semanal por HTTP', () => {
  it('crear (también nocturno), consultar la semana, vista previa (dryRun), publicar e historial', async () => {
    const night = await fAdmin.post('/api/shifts', body(S.employees.ven, S.fatboy.VEN, '2026-10-12', '19:00', '03:00'));
    expect(night.status).toBe(201);
    expect(night.body).toMatchObject({ startTime: '19:00', endTime: '03:00', endDate: '2026-10-13', crossesMidnight: true, scheduledMinutes: 480, timezone: 'America/Tijuana' });

    const dry = await fAdmin.post('/api/shifts', body(S.employees.ven, S.fatboy.VEN, '2026-10-14', '07:00', '15:00', { dryRun: true }));
    expect(dry.status).toBe(201);
    const week = await fAdmin.get(`/api/schedules/week?branchId=${S.fatboy.VEN}&date=2026-10-15`);
    expect(week.body).toMatchObject({ weekStart: '2026-10-12', schedule: { status: 'DRAFT' }, branch: { timezone: 'America/Tijuana' } });
    expect(week.body.shifts.map((s: { id: string }) => s.id)).toEqual([night.body.id]); // el dryRun no guardó nada
    expect(week.body.employees.map((e: { id: string }) => e.id)).toContain(S.employees.ven);

    const stale = await fAdmin.post(`/api/schedules/${week.body.schedule.id}/publish`, { expectedVersion: week.body.schedule.version - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('SCHEDULE_VERSION_CONFLICT');
    const pub = await fAdmin.post(`/api/schedules/${week.body.schedule.id}/publish`, { expectedVersion: week.body.schedule.version });
    expect(pub.body.status).toBe('PUBLISHED');

    const edit = await fAdmin.patch(`/api/shifts/${night.body.id}`, { expectedVersion: night.body.version, endTime: '04:00' });
    expect(edit.body).toMatchObject({ endTime: '04:00', scheduledMinutes: 540 });
    const conflict = await manager.patch(`/api/shifts/${night.body.id}`, { expectedVersion: night.body.version, notes: 'vieja' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('SHIFT_VERSION_CONFLICT');

    const history = await manager.get(`/api/shifts/${night.body.id}/history`);
    expect(history.body.map((h: { action: string }) => h.action)).toEqual(['shift.updated', 'shift.created']);
    expect(history.body[0].before.endTime).toBe('03:00');
    expect(history.body[0].after.endTime).toBe('04:00');

    expect((await fAdmin.post(`/api/shifts/${night.body.id}/cancel`, { expectedVersion: edit.body.version })).status).toBe(400);
    const cancel = await fAdmin.post(`/api/shifts/${night.body.id}/cancel`, { expectedVersion: edit.body.version, reason: 'Cierre por evento' });
    expect(cancel.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Cierre por evento' });
    expect((await fAdmin.request('DELETE', `/api/shifts/${night.body.id}?expectedVersion=${cancel.body.version}`)).status).toBe(409);
  });

  it('DST por HTTP: hora inexistente ⇒ 400 explícito; ambigua ⇒ opciones y se elige con fold', async () => {
    const gap = await fAdmin.post('/api/shifts', body(S.employees.ven, S.fatboy.VEN, '2027-03-14', '02:30', '10:00'));
    expect(gap.body.error.code).toBe('LOCAL_TIME_NONEXISTENT');
    const amb = await fAdmin.post('/api/shifts', body(S.employees.ven, S.fatboy.VEN, '2026-11-01', '01:30', '09:30'));
    expect(amb.body.error).toMatchObject({ code: 'LOCAL_TIME_AMBIGUOUS', details: { options: [{ fold: 'EARLIER' }, { fold: 'LATER' }] } });
    const ok = await fAdmin.post('/api/shifts', body(S.employees.ven, S.fatboy.VEN, '2026-11-01', '01:30', '09:30', { startFold: 'EARLIER' }));
    expect(ok.body.startsAt).toBe('2026-11-01T08:30:00.000Z');
  });

  it('copiar semana por HTTP con resultado detallado', async () => {
    await fAdmin.post('/api/shifts', body(S.employees.ven, S.fatboy.VEN, '2026-10-20', '07:00', '15:00'));
    const prev = await fAdmin.post('/api/schedules/copy', { branchId: S.fatboy.VEN, sourceWeek: '2026-10-19', dryRun: true });
    expect(prev.body).toMatchObject({ weekStart: '2026-10-26', dryRun: true });
    expect(prev.body.created).toHaveLength(1);
    const real = await fAdmin.post('/api/schedules/copy', { branchId: S.fatboy.VEN, sourceWeek: '2026-10-19' });
    expect(real.body.created[0]).toMatchObject({ businessDate: '2026-10-27', startTime: '07:00', source: 'COPY' });
  });

  it('próximos turnos del empleado respetan el alcance', async () => {
    const mine = await manager.get(`/api/employees/${S.employees.ven}/shifts`);
    expect(mine.status).toBe(200);
    expect(mine.body.every((s: { branchId: string }) => s.branchId === S.fatboy.VEN)).toBe(true);
    expect((await manager.get(`/api/employees/${S.employees.sma}/shifts`)).status).toBe(404);
  });
});

describe('RBAC y aislamiento en la planificación', () => {
  it('(13)(14) el encargado de Venecia no programa San Marcos ni empleados no asignados a Venecia', async () => {
    expect((await manager.post('/api/shifts', body(S.employees.sma, S.fatboy.SMA, '2026-10-21', '07:00', '15:00'))).status).toBe(403);
    const notAssigned = await manager.post('/api/shifts', body(S.employees.sma, S.fatboy.VEN, '2026-10-21', '07:00', '15:00'));
    expect(notAssigned.body.error.code).toBe('EMPLOYEE_NOT_ASSIGNED_TO_BRANCH');
    expect((await manager.get(`/api/schedules/week?branchId=${S.fatboy.SMA}&date=2026-10-21`)).status).toBe(404);
    expect((await manager.post('/api/schedules/copy', { branchId: S.fatboy.SMA, sourceWeek: '2026-10-12' })).status).toBe(403);
    expect((await manager.post('/api/shifts', body(S.employees.ven, S.fatboy.VEN, '2026-10-21', '07:00', '15:00'))).status).toBe(201);
  });

  it('(15) el admin programa cualquier sucursal de su negocio', async () => {
    for (const [emp, branch] of [[S.employees.sma, S.fatboy.SMA], [S.employees.ven, S.fatboy.VEN]] as const) {
      expect((await fAdmin.post('/api/shifts', body(emp, branch, '2026-10-23', '07:00', '15:00'))).status).toBe(201);
    }
  });

  it('(16)(17) el negocio A no lee ni modifica turnos ni horarios del B', async () => {
    expect((await fAdmin.get(`/api/shifts/${pizzaShift.id}`)).status).toBe(404);
    expect((await fAdmin.get(`/api/shifts/${pizzaShift.id}/history`)).status).toBe(404);
    expect((await fAdmin.patch(`/api/shifts/${pizzaShift.id}`, { expectedVersion: pizzaShift.version, startTime: '10:00' })).status).toBe(404);
    expect((await fAdmin.post(`/api/shifts/${pizzaShift.id}/cancel`, { expectedVersion: pizzaShift.version, reason: 'x' })).status).toBe(404);
    expect((await fAdmin.get(`/api/schedules/week?branchId=${S.pizza.CEN}&date=2026-10-13`)).status).toBe(404);
    expect((await fAdmin.post('/api/shifts', body(S.employees.pizza, S.pizza.CEN, '2026-10-24', '07:00', '15:00'))).status).toBe(404); // ni siquiera existe para A
    expect((await pools.platform.query(`SELECT status, version FROM scheduling.shifts WHERE id = $1`, [pizzaShift.id])).rows[0]).toEqual({ status: 'SCHEDULED', version: 1 });
  });

  it('(18) enviar otro organization_id no cambia el tenant', async () => {
    const r = await fAdmin.post('/api/shifts', { ...body(S.employees.ven, S.fatboy.VEN, '2026-10-25', '07:00', '15:00'), organizationId: S.pizza.id, organization_id: S.pizza.id }, { 'x-organization-id': S.pizza.id });
    expect(r.status).toBe(201);
    const db = (await pools.platform.query(`SELECT organization_id FROM scheduling.shifts WHERE id = $1`, [r.body.id])).rows[0];
    expect(db.organization_id).toBe(S.fatboy.id);
    const w = await fAdmin.get(`/api/schedules/week?branchId=${S.fatboy.VEN}&date=2026-10-25&organizationId=${S.pizza.id}`);
    expect(w.body.shifts.every((s: { branchId: string }) => s.branchId === S.fatboy.VEN)).toBe(true);
  });

  it('(35) con el RBAC "roto" (todo permitido), RLS impide ver o modificar turnos de otro negocio', async () => {
    const container = createContainer({ appPool: pools.app, pinPepper: PEPPER });
    const all = new Set((await pools.platform.query('SELECT code FROM core.permissions')).rows.map((r) => r.code as string));
    container.rbac.loadAccess = async () => new AccessProfile([{ permissions: all, branchIds: null }]);
    const buggy = await startServer(pools, container);
    try {
      const m = new Agent(buggy.baseUrl);
      await m.login(S.managerVenEmail, PASSWORD);
      expect((await m.get(`/api/shifts/${pizzaShift.id}`)).status).toBe(404);
      expect((await m.patch(`/api/shifts/${pizzaShift.id}`, { expectedVersion: 1, startTime: '10:00' })).status).toBe(404);
      expect((await m.post(`/api/shifts/${pizzaShift.id}/cancel`, { expectedVersion: 1, reason: 'x' })).status).toBe(404);
      expect((await m.get(`/api/schedules/week?branchId=${S.pizza.CEN}&date=2026-10-13`)).status).toBe(404);
      expect((await m.post('/api/shifts', body(S.employees.pizza, S.pizza.CEN, '2026-10-26', '07:00', '15:00'))).status).toBe(404);
      expect((await m.post('/api/schedules/copy', { branchId: S.pizza.CEN, sourceWeek: '2026-10-12' })).status).toBe(404);
      expect((await pools.platform.query(`SELECT status, version FROM scheduling.shifts WHERE id = $1`, [pizzaShift.id])).rows[0]).toEqual({ status: 'SCHEDULED', version: 1 });
    } finally {
      await buggy.close();
    }
  });
});

describe('plantillas por HTTP', () => {
  it('crear, editar con versión, aplicar a una semana', async () => {
    const t = await fAdmin.post('/api/schedule-templates', { branchId: S.fatboy.VEN, name: 'Semana tipo' });
    expect(t.status).toBe(201);
    const put = await fAdmin.put(`/api/schedule-templates/${t.body.id}`, { expectedVersion: t.body.version, entries: [{ employeeId: S.employees.ven, weekday: 3, startTime: '19:00', endTime: '03:00' }] });
    expect(put.body.entries).toEqual([expect.objectContaining({ weekday: 3, startTime: '19:00', endTime: '03:00' })]);
    expect((await fAdmin.put(`/api/schedule-templates/${t.body.id}`, { expectedVersion: t.body.version, entries: [] })).status).toBe(409);
    const applied = await fAdmin.post(`/api/schedule-templates/${t.body.id}/apply`, { weekStart: '2026-11-16' });
    expect(applied.body.created[0]).toMatchObject({ businessDate: '2026-11-18', startTime: '19:00', source: 'TEMPLATE' });
    expect((await manager.post('/api/schedule-templates', { branchId: S.fatboy.VEN, name: 'x' })).status).toBe(403);
  });
});

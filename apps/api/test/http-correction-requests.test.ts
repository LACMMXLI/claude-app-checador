import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainer } from '../src/container.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { AccessProfile } from '../src/modules/auth/rbac.service.js';
import { type AttendanceFixture, at, attendanceFixture } from './helpers/attendance-fixture.js';
import { PEPPER } from './helpers/config.js';
import { Agent, startServer, type TestServer } from './helpers/http.js';
import { PASSWORD, buildWorld, openPools } from './helpers/world.js';

const pools = openPools();
let now = new Date('2026-09-01T12:00:00Z');
const world = buildWorld(pools, { clock: () => now });
let server: TestServer;
let F: AttendanceFixture;
let B: AttendanceFixture;
let admin: Agent;
let manager: Agent;

beforeAll(async () => {
  F = await attendanceFixture(world, (d) => (now = d));
  B = await attendanceFixture(world, (d) => (now = d));
  await pools.platform.query(`INSERT INTO auth.user_credentials (user_id, password_hash) SELECT id, $2 FROM auth.users WHERE email = $1`, [F.managerEmail, await hashPassword(PASSWORD)]);
  server = await startServer(pools, world);
  admin = new Agent(server.baseUrl);
  await admin.login(F.adminEmail, PASSWORD);
  manager = new Agent(server.baseUrl);
  await manager.login(F.managerEmail, PASSWORD);
});
afterAll(async () => {
  await server.close();
  await pools.close();
});

async function tablet(branchId: string) {
  const created = await admin.post('/api/kiosks', { name: `T-${randomUUID().slice(0, 4)}`, branchId });
  const browser = new Agent(server.baseUrl);
  expect((await browser.post('/api/kiosk/activate', { credential: created.body.token })).status).toBe(200);
  return browser;
}

describe('solicitudes por HTTP', () => {
  it('/auth/me expone la ficha ligada (habilita "Mis jornadas") solo a quien la tiene', async () => {
    expect((await manager.get('/api/auth/me')).body.employeeId).toBe(F.lupe.id);
    expect((await admin.get('/api/auth/me')).body.employeeId).toBeNull();
    expect((await admin.get('/api/attendance/my/sessions?branchId=' + F.VEN)).body.error.code).toBe('NO_EMPLOYEE_RECORD');
  });

  it('kiosco: PIN → Mis registros → solicitar; panel: bandeja → aprobar; el pase nunca viaja en la URL', async () => {
    const p = await F.employee('Http', F.VEN);
    await F.publishedShift(p, F.VEN, '2026-10-05', '07:00', '15:00');
    const k = await tablet(F.VEN);
    now = at('2026-10-05', '07:15');
    const id1 = await k.post('/api/kiosk/identify', { pin: p.pin });
    const inRes = await k.post('/api/kiosk/punch', { ticket: id1.body.ticket, action: 'CLOCK_IN', clientEventId: randomUUID() });
    expect(inRes.status).toBe(200);
    now = at('2026-10-05', '18:00');
    const id2 = await k.post('/api/kiosk/identify', { pin: p.pin });
    const rec = await k.post('/api/kiosk/my-records', { ticket: id2.body.ticket });
    expect(rec.status).toBe(200);
    expect(rec.body.sessions).toEqual([expect.objectContaining({ id: inRes.body.workSessionId, operationalDate: '2026-10-05' })]);
    const created = await k.post('/api/kiosk/correction-requests', {
      ticket: rec.body.ticket, clientRequestId: randomUUID(), action: 'SET_CLOCK_IN', workSessionId: inRes.body.workSessionId,
      start: { date: '2026-10-05', time: '07:00' }, reason: 'La fila del kiosco', organizationId: B.orgId,
    });
    expect(created.body.request).toMatchObject({ status: 'PENDING', channel: 'KIOSK' });
    // sin la cabecera anti-CSRF (cookie del kiosco) se rechaza
    expect((await k.post('/api/kiosk/my-records', { ticket: rec.body.ticket }, { 'x-requested-with': '' })).status).toBe(403);

    expect((await manager.get('/api/attendance/correction-requests/summary')).body.pending).toBeGreaterThanOrEqual(1);
    const inbox = await manager.get('/api/attendance/correction-requests?status=PENDING');
    const item = inbox.body.find((r: { id: string }) => r.id === created.body.request.id);
    expect(item).toMatchObject({ canDecide: true, employee: { firstName: 'Http' } });
    const detail = await manager.get(`/api/attendance/correction-requests/${item.id}`);
    expect(detail.body).toMatchObject({ timezone: 'America/Tijuana', recorded: [expect.objectContaining({ type: 'CLOCK_IN' })] });
    const ok = await manager.post(`/api/attendance/correction-requests/${item.id}/approve`, { expectedVersion: item.version, expectedSessionVersion: detail.body.session.version });
    expect(ok.status).toBe(200);
    expect(ok.body.request.status).toBe('APPROVED');
    const again = await manager.post(`/api/attendance/correction-requests/${item.id}/approve`, { expectedVersion: item.version, expectedSessionVersion: detail.body.session.version });
    expect(again.status).toBe(409);
  });

  it('panel: solicitar exige ficha ligada; la encargada solicita la suya y no puede aprobarla', async () => {
    const noEmployee = await admin.post('/api/attendance/correction-requests', { clientRequestId: randomUUID(), action: 'CREATE_SESSION', branchId: F.VEN, start: { date: '2026-10-06', time: '07:00' }, end: { date: '2026-10-06', time: '08:00' }, reason: 'x' });
    expect(noEmployee).toMatchObject({ status: 403, body: { error: { code: 'NO_EMPLOYEE_RECORD' } } });
    now = at('2026-10-06', '18:00');
    const own = await manager.post('/api/attendance/correction-requests', { clientRequestId: randomUUID(), action: 'CREATE_SESSION', branchId: F.VEN, start: { date: '2026-10-06', time: '07:00' }, end: { date: '2026-10-06', time: '15:00' }, reason: 'Olvidé checar todo el día' });
    expect(own.status).toBe(201);
    const self = await manager.post(`/api/attendance/correction-requests/${own.body.request.id}/approve`, { expectedVersion: 1 });
    expect(self).toMatchObject({ status: 403, body: { error: { code: 'SELF_APPROVAL_FORBIDDEN' } } });
    const mine = await manager.get(`/api/attendance/my/sessions?branchId=${F.VEN}`);
    expect(mine.body.requests.map((r: { id: string }) => r.id)).toContain(own.body.request.id);
    const rej = await admin.post(`/api/attendance/correction-requests/${own.body.request.id}/reject`, { expectedVersion: 1, reason: 'No hay evidencia' });
    expect(rej.body).toMatchObject({ status: 'REJECTED' });
  });

  it('con el RBAC "roto", RLS impide ver o decidir solicitudes de otro negocio', async () => {
    const p = await B.employee('Beta', B.VEN);
    now = at('2026-10-07', '08:00');
    const r0 = await B.punch(B.kioskVEN, p, 'CLOCK_IN');
    now = at('2026-10-07', '12:00');
    const t = (await world.kioskAttendance.identify(B.kioskVEN.ctx, B.kioskVEN, p.pin)).ticket;
    const req = await world.kioskAttendance.requestCorrection(B.kioskVEN.ctx, B.kioskVEN, t, { clientRequestId: randomUUID(), action: 'SET_CLOCK_IN', workSessionId: r0.workSessionId, start: { date: '2026-10-07', time: '07:55' }, reason: 'x' });
    const container = createContainer({ appPool: pools.app, pinPepper: PEPPER, clock: () => now });
    const all = new Set((await pools.platform.query('SELECT code FROM core.permissions')).rows.map((r) => r.code as string));
    container.rbac.loadAccess = async () => new AccessProfile([{ permissions: all, branchIds: null }]);
    const buggy = await startServer(pools, container);
    try {
      const m = new Agent(buggy.baseUrl);
      await m.login(F.managerEmail, PASSWORD);
      expect((await m.get(`/api/attendance/correction-requests/${req.request.id}`)).status).toBe(404);
      expect((await m.post(`/api/attendance/correction-requests/${req.request.id}/approve`, { expectedVersion: 1, expectedSessionVersion: 1 })).status).toBe(404);
      expect((await m.post(`/api/attendance/correction-requests/${req.request.id}/reject`, { expectedVersion: 1, reason: 'x' })).status).toBe(404);
      expect((await m.get('/api/attendance/correction-requests')).body.some((r: { id: string }) => r.id === req.request.id)).toBe(false);
      expect((await pools.platform.query('SELECT status FROM attendance.correction_requests WHERE id = $1', [req.request.id])).rows[0].status).toBe('PENDING');
    } finally {
      await buggy.close();
    }
  });
});

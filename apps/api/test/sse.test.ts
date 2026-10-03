import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainer } from '../src/container.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { type AttendanceFixture, at, attendanceFixture } from './helpers/attendance-fixture.js';
import { PEPPER } from './helpers/config.js';
import { Agent, startServer, type TestServer } from './helpers/http.js';
import { openStream } from './helpers/sse.js';
import { PASSWORD, buildWorld, openPools } from './helpers/world.js';

const pools = openPools();
let now = new Date('2026-09-01T12:00:00Z');
const world = buildWorld(pools, { clock: () => now });
let server: TestServer;
let F: AttendanceFixture;
let B: AttendanceFixture;
let admin: Agent;
const streams: { close: () => void }[] = [];

beforeAll(async () => {
  F = await attendanceFixture(world, (d) => (now = d));
  B = await attendanceFixture(world, (d) => (now = d));
  await pools.platform.query(`INSERT INTO auth.user_credentials (user_id, password_hash) SELECT id, $2 FROM auth.users WHERE email = $1`, [F.managerEmail, await hashPassword(PASSWORD)]);
  server = await startServer(pools, world, false, { sse: { pingMs: 200, revalidateMs: 300, maxLifetimeMs: 60_000, maxPerUser: 5 } });
  admin = new Agent(server.baseUrl);
  await admin.login(F.adminEmail, PASSWORD);
});
afterAll(async () => {
  streams.forEach((s) => s.close());
  await server.close();
  await pools.close();
});

async function stream(agent: Agent, path?: string) {
  streams.splice(0).forEach((x) => x.close()); // una conexión viva por prueba (el límite por usuario es de 5)
  await new Promise((ok) => setTimeout(ok, 100));
  const s = await openStream(agent, server.baseUrl, path);
  streams.push(s);
  expect(await s.waitFor((e) => e.event === 'ready')).toBeTruthy();
  return s;
}

describe('tiempo real por SSE (D-75)', () => {
  it('una checada llega como invalidación con identificadores mínimos (sin datos personales); también hay ping', async () => {
    const s = await stream(admin);
    expect(s.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(s.headers.get('x-accel-buffering')).toBe('no');
    const p = await F.employee('Visible', F.VEN);
    now = at('2026-10-05', '08:00');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    const e = await s.waitFor((x) => x.event === 'attendance.session' && x.data.id === r.workSessionId);
    expect(e?.data).toEqual({ id: r.workSessionId, branchId: F.VEN, op: 'insert' });
    expect(JSON.stringify(s.events)).not.toMatch(/Visible|PIN|pin/);
    expect(await s.waitFor((x) => x.event === 'attendance.incident')).toBeTruthy(); // SIN_TURNO_PROGRAMADO
    expect(await s.waitFor((x) => x.event === 'ping')).toBeTruthy();
  });

  it('un aviso del negocio B nunca llega a un suscriptor de A; la encargada solo recibe sus sucursales', async () => {
    const manager = new Agent(server.baseUrl);
    await manager.login(F.managerEmail, PASSWORD);
    const a = await stream(admin);
    const m = await openStream(manager, server.baseUrl);
    streams.push(m);
    expect(await m.waitFor((e) => e.event === 'ready')).toBeTruthy();
    const pb = await B.employee('Ajeno', B.VEN);
    const psma = await F.employee('SanMarcos', F.SMA);
    const pven = await F.employee('Venecia', F.VEN);
    now = at('2026-10-06', '08:00');
    const rb = await B.punch(B.kioskVEN, pb, 'CLOCK_IN');
    const rsma = await F.punch(F.kioskSMA, psma, 'CLOCK_IN');
    const rven = await F.punch(F.kioskVEN, pven, 'CLOCK_IN');
    expect(await a.waitFor((x) => x.data.id === rven.workSessionId)).toBeTruthy();
    expect(await m.waitFor((x) => x.data.id === rven.workSessionId)).toBeTruthy();
    expect(await a.waitFor((x) => x.data.id === rsma.workSessionId)).toBeTruthy();
    expect(a.events.some((x) => x.data.id === rb.workSessionId)).toBe(false);
    expect(m.events.some((x) => x.data.id === rb.workSessionId || x.data.id === rsma.workSessionId || x.data.branchId === F.SMA)).toBe(false);
    // y no se puede pedir una sucursal fuera del alcance ni de otro negocio
    expect((await openStream(manager, server.baseUrl, `/api/attendance/stream?branchId=${F.SMA}`)).status).toBe(404);
    expect((await openStream(admin, server.baseUrl, `/api/attendance/stream?branchId=${B.VEN}`)).status).toBe(404);
  });

  it('solo se avisa lo CONFIRMADO: una transacción revertida no emite nada', async () => {
    const s = await stream(admin);
    const p = await F.employee('Revertido', F.VEN);
    now = at('2026-10-07', '08:00');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    await s.waitFor((x) => x.data.id === r.workSessionId);
    const before = s.events.length;
    const c = await pools.superuser.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE attendance.work_sessions SET version = version + 1 WHERE id = $1', [r.workSessionId]);
      await c.query('ROLLBACK');
      await new Promise((ok) => setTimeout(ok, 500));
      expect(s.events.slice(before).some((x) => x.data.id === r.workSessionId)).toBe(false);
      await c.query('UPDATE attendance.work_sessions SET version = version + 1 WHERE id = $1', [r.workSessionId]);
    } finally {
      c.release();
    }
    expect(await s.waitFor((x, i = s.events.indexOf(x)) => i >= before && x.data.id === r.workSessionId && x.data.op === 'update')).toBeTruthy();
  });

  it('la reconciliación (otro proceso) también avisa, por la base de datos', async () => {
    const s = await stream(admin);
    const p = await F.employee('Falta', F.VEN);
    const shift = await F.publishedShift(p, F.VEN, '2026-10-08', '07:00', '09:00');
    now = at('2026-10-08', '10:00');
    const otherProcess = createContainer({ appPool: pools.app, pinPepper: PEPPER, clock: () => now });
    await otherProcess.reconciler.reconcileOrganization(F.orgId);
    const falta = (await pools.platform.query(`SELECT id FROM attendance.incidents WHERE shift_id = $1`, [shift.id])).rows[0].id;
    expect(await s.waitFor((x) => x.event === 'attendance.incident' && x.data.id === falta)).toBeTruthy();
  });

  it('si la sesión se revoca, el flujo se cierra en la siguiente revalidación', async () => {
    const other = new Agent(server.baseUrl);
    await other.login(F.adminEmail, PASSWORD);
    const s = await stream(other);
    await other.post('/api/auth/logout');
    const deadline = Date.now() + 3000;
    while (!s.ended && Date.now() < deadline) await new Promise((ok) => setTimeout(ok, 100));
    expect(s.ended).toBe(true);
  });

  it('si se pierde la conexión LISTEN, el servidor reconecta y pide "resync" (el cliente recarga)', async () => {
    const s = await stream(admin);
    const pid = await world.notifications.backendPid();
    await pools.superuser.query('SELECT pg_terminate_backend($1)', [pid]);
    expect(await s.waitFor((x) => x.event === 'resync', 5000)).toBeTruthy();
    const p = await F.employee('DespuesDeReconectar', F.VEN);
    now = at('2026-10-09', '08:00');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    expect(await s.waitFor((x) => x.data.id === r.workSessionId, 5000)).toBeTruthy();
  });

  it('límite de conexiones por usuario; sin sesión no hay flujo', async () => {
    const u = new Agent(server.baseUrl);
    await u.login(B.adminEmail, PASSWORD);
    const opened = [];
    for (let i = 0; i < 6; i += 1) {
      const s = await openStream(u, server.baseUrl);
      streams.push(s);
      opened.push(s.status);
    }
    expect(opened).toEqual([200, 200, 200, 200, 200, 429]);
    expect((await openStream(new Agent(server.baseUrl), server.baseUrl)).status).toBe(401);
  });
});

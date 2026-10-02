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
  // la encargada de la fixture no tiene contraseña: se la damos (como lo haría la plataforma)
  await pools.platform.query(
    `INSERT INTO auth.user_credentials (user_id, password_hash) SELECT id, $2 FROM auth.users WHERE email = $1`,
    [F.managerEmail, await hashPassword(PASSWORD)],
  );
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

const cookieHeader = (r: { headers: Headers }) => r.headers.getSetCookie().find((c) => c.startsWith('kiosk='));

/** Crea un kiosco desde el panel y ACTIVA un navegador con el token (D-56). */
async function activatedKiosk(branchId: string) {
  const created = await admin.post('/api/kiosks', { name: `Tablet ${randomUUID().slice(0, 4)}`, branchId });
  expect(created.status).toBe(201);
  const browser = new Agent(server.baseUrl);
  const act = await browser.post('/api/kiosk/activate', { credential: created.body.token });
  expect(act.status).toBe(200);
  return { browser, token: created.body.token as string, id: created.body.device.id as string, activation: act };
}

const punchVia = async (browser: Agent, pin: string, action: string, clientEventId = randomUUID()) => {
  const id = await browser.post('/api/kiosk/identify', { pin });
  if (id.status !== 200) return id;
  return browser.post('/api/kiosk/punch', { ticket: id.body.ticket, action, clientEventId });
};

describe('kiosco: activación y credencial del dispositivo (D-56)', () => {
  it('activar con el token: cookie HttpOnly/SameSite=Strict, el token pegado ya no sirve y nunca vuelve en la respuesta', async () => {
    const { browser, token, activation } = await activatedKiosk(F.VEN);
    const cookie = cookieHeader(activation)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toContain(token); // la credencial se ROTÓ
    expect(JSON.stringify(activation.body)).not.toMatch(/kt_/);
    expect(activation.body).toMatchObject({ organization: { name: 'Fatboy' }, branch: { name: 'Venecia' } });

    // el token mostrado una vez es de un solo uso: no activa otro navegador ni sirve como Bearer
    expect((await new Agent(server.baseUrl).post('/api/kiosk/activate', { credential: token })).status).toBe(401);
    expect((await new Agent(server.baseUrl).post('/api/kiosk/identify', { pin: '123456' }, { authorization: `Bearer ${token}` })).body.error.code).toBe('KIOSK_TOKEN_INVALID');

    const session = await browser.get('/api/kiosk/session');
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ branch: { name: 'Venecia', timezone: 'America/Tijuana' } });
    // con cookie, las acciones exigen la cabecera anti-CSRF
    expect((await browser.post('/api/kiosk/identify', { pin: '123456' }, { 'x-requested-with': '' })).status).toBe(403);
    // sin activar: 401 claro
    expect((await new Agent(server.baseUrl).get('/api/kiosk/session')).body.error.code).toBe('KIOSK_NOT_ACTIVATED');
  });

  it('activar con un código de emparejamiento también deja solo la cookie', async () => {
    const code = await world.kiosks.createPairingCode(F.ctx, F.SMA);
    const browser = new Agent(server.baseUrl);
    const act = await browser.post('/api/kiosk/activate', { credential: code.code.toLowerCase(), deviceName: 'Tablet SMA' });
    expect(act.status).toBe(200);
    expect(act.body.branch.name).toBe('San Marcos');
    expect((await browser.get('/api/kiosk/session')).status).toBe(200);
  });

  it('(45) revocar el token desde el panel impide nuevas checadas', async () => {
    const p = await F.employee('Rita', F.VEN);
    const { browser, id } = await activatedKiosk(F.VEN);
    now = at('2026-10-05', '08:00');
    expect((await punchVia(browser, p.pin, 'CLOCK_IN')).status).toBe(200);
    expect((await admin.post(`/api/kiosks/${id}/token/revoke`, { reason: 'Tablet robada' })).status).toBe(200);
    const after = await punchVia(browser, p.pin, 'CLOCK_OUT');
    expect(after).toMatchObject({ status: 401, body: { error: { code: 'KIOSK_TOKEN_INVALID' } } });
    expect((await browser.get('/api/kiosk/session')).status).toBe(401);
    expect(browser.cookies.has('kiosk')).toBe(false); // el servidor borró la cookie
  });

  it('(46) un dispositivo desactivado no puede checar (aunque conserve su credencial)', async () => {
    const p = await F.employee('Sergio', F.VEN);
    const { browser, id } = await activatedKiosk(F.VEN);
    // obtener un pase ANTES de desactivar: tampoco sirve después
    const ident = await browser.post('/api/kiosk/identify', { pin: p.pin });
    expect(ident.status).toBe(200);
    expect((await admin.post(`/api/kiosks/${id}/status`, { status: 'INACTIVE', reason: 'En reparación' })).status).toBe(200);
    const punch = await browser.post('/api/kiosk/punch', { ticket: ident.body.ticket, action: 'CLOCK_IN', clientEventId: randomUUID() });
    expect(punch).toMatchObject({ status: 401, body: { error: { code: 'KIOSK_TOKEN_INVALID' } } });
    expect(await pools.platform.query('SELECT count(*)::int AS n FROM attendance.work_sessions WHERE employee_id = $1', [p.id]).then((r) => r.rows[0].n)).toBe(0);
  });

  it('(47)(48) PIN incorrecto mantiene la pausa progresiva D-21; el correcto reinicia el contador; el PIN no se registra', async () => {
    const p = await F.employee('Tere', F.VEN);
    const { browser, id } = await activatedKiosk(F.VEN);
    now = at('2026-10-06', '09:00');
    const wrong = p.pin === '246813' ? '135792' : '246813';
    for (let i = 0; i < 5; i += 1) {
      expect((await browser.post('/api/kiosk/identify', { pin: wrong })).body.error.code).toBe('INVALID_PIN');
    }
    const paused = await browser.post('/api/kiosk/identify', { pin: p.pin });
    expect(paused).toMatchObject({ status: 429, body: { error: { code: 'PIN_PAUSED', details: { retryAfterSec: 10 } } } });
    now = new Date(now.getTime() + 11_000);
    expect((await browser.post('/api/kiosk/identify', { pin: p.pin })).status).toBe(200); // (48) reinicia
    expect((await browser.post('/api/kiosk/identify', { pin: wrong })).body.error.code).toBe('INVALID_PIN'); // sin pausa
    const audit = await pools.platform.query(`SELECT action, after::text AS a FROM audit.audit_log WHERE organization_id = $1 AND entity_id = $2`, [F.orgId, id]);
    expect(audit.rows.map((r) => r.action)).toContain('security.pin_pause_started');
    const all = (await pools.platform.query(`SELECT coalesce(string_agg(coalesce(before::text,'') || coalesce(after::text,''), ' '), '') AS t FROM audit.audit_log WHERE organization_id = $1`, [F.orgId])).rows[0].t as string;
    expect(all).not.toContain(p.pin);
    expect(all).not.toContain(wrong);
  });
});

describe('flujo completo por HTTP: kiosco → tablero → corrección → historial', () => {
  it('Entrada tardía, comida, regreso, Salida; tablero; corrección autorizada; el encargado no se corrige a sí mismo', async () => {
    const p = await F.employee('Ulises', F.VEN);
    await F.publishedShift(p, F.VEN, '2026-10-07', '07:00', '15:00');
    const { browser } = await activatedKiosk(F.VEN);
    now = at('2026-10-07', '07:20');
    const ident = await browser.post('/api/kiosk/identify', { pin: p.pin });
    expect(ident.body).toMatchObject({ employee: { displayName: 'Ulises' }, actions: ['CLOCK_IN'], shift: { startTime: '07:00', endTime: '15:00' } });
    const clientEventId = randomUUID();
    const inRes = await browser.post('/api/kiosk/punch', { ticket: ident.body.ticket, action: 'CLOCK_IN', clientEventId, organizationId: B.orgId });
    expect(inRes.body).toMatchObject({ action: 'CLOCK_IN', arrivalDeltaMinutes: 20 });
    const retry = await browser.post('/api/kiosk/punch', { ticket: ident.body.ticket, action: 'CLOCK_IN', clientEventId });
    expect(retry.body).toMatchObject({ replayed: true, workSessionId: inRes.body.workSessionId });

    let board = await admin.get(`/api/attendance/board?branchId=${F.VEN}&date=2026-10-07`);
    let row = board.body.rows.find((r: { employee: { id: string } }) => r.employee.id === p.id);
    expect(row).toMatchObject({ state: 'WORKING', arrivalDeltaMinutes: 20, late: true });

    now = at('2026-10-07', '11:00');
    expect((await punchVia(browser, p.pin, 'BREAK_START')).status).toBe(200);
    board = await admin.get(`/api/attendance/board?branchId=${F.VEN}&date=2026-10-07`);
    row = board.body.rows.find((r: { employee: { id: string } }) => r.employee.id === p.id);
    expect(row.state).toBe('ON_BREAK');
    expect(board.body.counters.onBreak).toBeGreaterThanOrEqual(1);
    now = at('2026-10-07', '11:40');
    expect((await punchVia(browser, p.pin, 'BREAK_END')).body.break).toMatchObject({ durationMinutes: 40, exceededMinutes: 5 });
    now = at('2026-10-07', '15:00');
    expect((await punchVia(browser, p.pin, 'CLOCK_OUT')).body).toMatchObject({ action: 'CLOCK_OUT', elapsedMinutes: 460 });

    const sessionId = inRes.body.workSessionId as string;
    const detail = await manager.get(`/api/attendance/sessions/${sessionId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.recorded.map((e: { type: string }) => e.type)).toEqual(['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT']);
    const corr = await manager.post(`/api/attendance/sessions/${sessionId}/corrections`, {
      action: 'SET_CLOCK_IN', at: { date: '2026-10-07', time: '07:05' }, expectedVersion: detail.body.effective.version, reason: 'Checó tarde por fila en el kiosco',
      organizationId: B.orgId, // ignorado: el negocio sale de la sesión
    });
    expect(corr.status).toBe(200);
    const history = await admin.get(`/api/attendance/employees/${p.id}/history?from=2026-10-01&to=2026-10-31`);
    expect(history.body.sessions[0]).toMatchObject({ metrics: { arrivalDeltaMinutes: 5, breakExcessMinutes: 5 }, corrections: { count: 1, lastBy: 'Lupe (encargada)' } });
    expect((await admin.post(`/api/attendance/sessions/${sessionId}/corrections`, { action: 'SET_CLOCK_IN', at: { date: '2026-10-07', time: '07:00' }, expectedVersion: 1, reason: 'x' })).status).toBe(409);
    expect((await admin.post(`/api/attendance/sessions/${sessionId}/corrections`, { action: 'SET_ANYTHING', field: 'employee_id', expectedVersion: 1, reason: 'x' })).status).toBe(400);

    // la encargada checa su propia jornada y no puede corregirla (403)
    now = at('2026-10-08', '08:00');
    const own = await punchVia(browser, F.lupe.pin, 'CLOCK_IN');
    const ownDetail = await manager.get(`/api/attendance/sessions/${own.body.workSessionId}`);
    const self = await manager.post(`/api/attendance/sessions/${own.body.workSessionId}/corrections`, { action: 'SET_CLOCK_IN', at: { date: '2026-10-08', time: '07:00' }, expectedVersion: ownDetail.body.effective.version, reason: 'Yo' });
    expect(self).toMatchObject({ status: 403, body: { error: { code: 'SELF_CORRECTION_FORBIDDEN' } } });
  });

  it('el encargado no ve el tablero ni las jornadas de una sucursal fuera de su alcance', async () => {
    expect((await manager.get(`/api/attendance/board?branchId=${F.SMA}`)).status).toBe(404);
    const list = await manager.get('/api/attendance/sessions?from=2026-01-01&to=2027-12-31');
    expect(list.status).toBe(200);
    expect(list.body.every((s: { branchId: string }) => s.branchId === F.VEN)).toBe(true);
  });
});

describe('aislamiento por negocio (39, 40)', () => {
  it('(40) con el RBAC "roto" (todo permitido), RLS impide ver o corregir jornadas e incidencias de otro negocio', async () => {
    const p = await B.employee('Beto B', B.VEN);
    now = at('2026-10-09', '08:00');
    const bSession = await B.punch(B.kioskVEN, p, 'CLOCK_IN');
    const container = createContainer({ appPool: pools.app, pinPepper: PEPPER, clock: () => now });
    const all = new Set((await pools.platform.query('SELECT code FROM core.permissions')).rows.map((r) => r.code as string));
    container.rbac.loadAccess = async () => new AccessProfile([{ permissions: all, branchIds: null }]);
    const buggy = await startServer(pools, container);
    try {
      const m = new Agent(buggy.baseUrl);
      await m.login(F.managerEmail, PASSWORD);
      expect((await m.get(`/api/attendance/sessions/${bSession.workSessionId}`)).status).toBe(404);
      expect((await m.post(`/api/attendance/sessions/${bSession.workSessionId}/corrections`, { action: 'SET_CLOCK_IN', at: { date: '2026-10-09', time: '07:00' }, expectedVersion: 1, reason: 'x' })).status).toBe(404);
      expect((await m.get(`/api/attendance/board?branchId=${B.VEN}`)).status).toBe(404);
      expect((await m.post('/api/attendance/sessions', { employeeId: p.id, branchId: B.VEN, start: { date: '2026-10-08', time: '07:00' }, end: { date: '2026-10-08', time: '15:00' }, reason: 'x' })).status).toBe(404);
      const incidents = await m.get('/api/attendance/incidents');
      expect(incidents.body.some((i: { employee: { id: string } }) => i.employee.id === p.id)).toBe(false);
      const hist = await m.get(`/api/attendance/employees/${p.id}/history?from=2026-10-01&to=2026-10-31`);
      expect(hist.status).toBe(404);
      const row = (await pools.platform.query('SELECT started_at, version FROM attendance.work_sessions WHERE id = $1', [bSession.workSessionId])).rows[0];
      expect(row).toEqual({ started_at: at('2026-10-09', '08:00'), version: 1 });
    } finally {
      await buggy.close();
    }
  });

  it('un kiosco solo checa en SU negocio: el PIN de otro negocio no identifica a nadie', async () => {
    const p = await B.employee('Solo B', B.VEN);
    const { browser } = await activatedKiosk(F.VEN);
    now = at('2026-10-10', '08:00');
    const r = await browser.post('/api/kiosk/identify', { pin: p.pin });
    // salvo coincidencia improbable de PIN con alguien de A, no existe en este negocio
    if (r.status === 200) expect(r.body.employee.id).not.toBe(p.id);
    else expect(r.body.error.code).toBe('INVALID_PIN');
  });
});

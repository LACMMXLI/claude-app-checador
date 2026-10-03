import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AttendanceFixture, type Kiosk, type Person, at, attendanceFixture } from './helpers/attendance-fixture.js';
import { count, pgError } from './helpers/sql.js';
import { buildWorld, openPools } from './helpers/world.js';

const pools = openPools();
let now = new Date('2026-09-01T12:00:00Z');
const world = buildWorld(pools, { clock: () => now });
const K = world.kioskAttendance;
const R = world.correctionRequests;
let F: AttendanceFixture;

beforeAll(async () => {
  F = await attendanceFixture(world, (d) => (now = d));
});
afterAll(() => pools.close());

const ticketOf = async (k: Kiosk, p: Person) => (await K.identify(k.ctx, k, p.pin)).ticket;
const request = (id: string) => pools.platform.query('SELECT * FROM attendance.correction_requests WHERE id = $1', [id]).then((r) => r.rows[0]);
const session = (id: string) => pools.platform.query('SELECT * FROM attendance.work_sessions WHERE id = $1', [id]).then((r) => r.rows[0]);

/** Jornada 07:12–15:00 del día dado con turno 07:00–15:00 (retardo 12). */
async function lateDay(p: Person, date: string) {
  await F.publishedShift(p, F.VEN, date, '07:00', '15:00');
  now = at(date, '07:12');
  const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
  now = at(date, '15:00');
  await F.punch(F.kioskVEN, p, 'CLOCK_OUT');
  return r.workSessionId;
}

async function ask(p: Person, input: Record<string, unknown>, k: Kiosk = F.kioskVEN) {
  return K.requestCorrection(k.ctx, k, await ticketOf(k, p), { clientRequestId: randomUUID(), reason: 'Llegué antes, el kiosco no respondía', ...input } as never);
}

describe('crear solicitudes desde el kiosco (D-70)', () => {
  it('queda PENDIENTE sin tocar la jornada; idempotente por clientRequestId; mismo id para otra acción se rechaza', async () => {
    const p = await F.employee('Sol', F.VEN);
    const s = await lateDay(p, '2026-10-05');
    now = at('2026-10-05', '18:00');
    const before = await session(s);
    const clientRequestId = randomUUID();
    const t = await ticketOf(F.kioskVEN, p);
    const input = { clientRequestId, action: 'SET_CLOCK_IN' as const, workSessionId: s, start: { date: '2026-10-05', time: '07:00' }, reason: 'Llegué a tiempo' };
    const first = await K.requestCorrection(F.kioskVEN.ctx, F.kioskVEN, t, input);
    expect(first).toMatchObject({ replayed: false, request: { status: 'PENDING', action: 'SET_CLOCK_IN', channel: 'KIOSK', operationalDate: '2026-10-05' } });
    expect(first.ticket).toBeTruthy(); // pase renovado mientras la pantalla siga en uso
    expect(await session(s)).toEqual(before); // nada cambia hasta aprobar
    const again = await K.requestCorrection(F.kioskVEN.ctx, F.kioskVEN, t, input);
    expect(again).toMatchObject({ replayed: true, request: { id: first.request.id } });
    await expect(K.requestCorrection(F.kioskVEN.ctx, F.kioskVEN, t, { ...input, action: 'SET_CLOCK_OUT' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await count(pools.platform, `SELECT count(*) FROM attendance.correction_requests WHERE employee_id = $1`, [p.id])).toBe(1);
  });

  it('nunca sobre la jornada de otra persona; motivo obligatorio; sin horas futuras', async () => {
    const a = await F.employee('Ajena', F.VEN);
    const b = await F.employee('Otro', F.VEN);
    const s = await lateDay(a, '2026-10-06');
    now = at('2026-10-06', '18:00');
    await expect(ask(b, { action: 'SET_CLOCK_IN', workSessionId: s, start: { date: '2026-10-06', time: '07:00' } })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(ask(a, { action: 'SET_CLOCK_IN', workSessionId: s, start: { date: '2026-10-06', time: '07:00' }, reason: '  ' })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    await expect(ask(a, { action: 'SET_CLOCK_OUT', workSessionId: s, start: { date: '2026-10-06', time: '19:00' } })).rejects.toMatchObject({ code: 'CORRECTION_IN_FUTURE' });
  });

  it('(A) la ventana es de 7 DÍAS OPERATIVOS de la sucursal, no 168 h desde el momento actual', async () => {
    const p = await F.employee('Ventana', F.VEN);
    const old = await lateDay(p, '2026-10-01'); // día operativo 1-oct
    const older = await lateDay(p, '2026-09-30');
    // 9-oct 03:00 (antes del corte de 05:00) ⇒ día operativo actual = 8-oct ⇒ 1-oct tiene antigüedad 7 (permitido),
    // aunque ya pasaron ~188 h desde esa jornada
    now = at('2026-10-09', '03:00');
    const ok = await ask(p, { action: 'SET_CLOCK_IN', workSessionId: old, start: { date: '2026-10-01', time: '07:00' } });
    expect(ok.request.operationalDate).toBe('2026-10-01');
    await expect(ask(p, { action: 'SET_CLOCK_IN', workSessionId: older, start: { date: '2026-09-30', time: '07:00' } })).rejects.toMatchObject({ code: 'REQUEST_OUTSIDE_WINDOW', details: { windowDays: 7 } });
    // a las 05:00 ya es el día operativo 9-oct: el 1-oct queda fuera
    now = at('2026-10-09', '05:00');
    await expect(ask(p, { action: 'SET_CLOCK_OUT', workSessionId: old, start: { date: '2026-10-01', time: '15:05' } })).rejects.toMatchObject({ code: 'REQUEST_OUTSIDE_WINDOW' });
  });

  it('máximo de pendientes (3) y una pendiente igual por objetivo', async () => {
    const p = await F.employee('Muchas', F.VEN);
    const s1 = await lateDay(p, '2026-10-12');
    const s2 = await lateDay(p, '2026-10-13');
    now = at('2026-10-13', '18:00');
    await ask(p, { action: 'SET_CLOCK_IN', workSessionId: s1, start: { date: '2026-10-12', time: '07:00' } });
    await expect(ask(p, { action: 'SET_CLOCK_IN', workSessionId: s1, start: { date: '2026-10-12', time: '07:01' } })).rejects.toMatchObject({ code: 'REQUEST_ALREADY_PENDING' });
    await ask(p, { action: 'SET_CLOCK_OUT', workSessionId: s1, start: { date: '2026-10-12', time: '15:10' } });
    await ask(p, { action: 'SET_CLOCK_IN', workSessionId: s2, start: { date: '2026-10-13', time: '07:00' } });
    await expect(ask(p, { action: 'SET_CLOCK_OUT', workSessionId: s2, start: { date: '2026-10-13', time: '15:10' } })).rejects.toMatchObject({ code: 'TOO_MANY_PENDING_REQUESTS', details: { max: 3 } });
  });

  it('(B) PostgreSQL garantiza una pendiente igual por objetivo para CADA acción, sin huecos por NULL', async () => {
    const p = await F.employee('Unica', F.VEN);
    const s = await lateDay(p, '2026-10-14');
    const shift = await F.publishedShift(p, F.VEN, '2026-10-15', '07:00', '15:00');
    const c = await pools.superuser.connect();
    const base = `INSERT INTO attendance.correction_requests (organization_id, branch_id, employee_id, operational_date, action, work_session_id, shift_id, proposed_start, proposed_end, reason, channel, requested_device_id, client_request_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now() - interval '2 hour', $8, 'x', 'KIOSK', $9, gen_random_uuid())`;
    const cases: [string, string, string | null, string | null, boolean][] = [
      ['SET_CLOCK_IN', '2026-10-14', s, null, false],
      ['SET_CLOCK_OUT', '2026-10-14', s, null, false],
      ['ADD_BREAK', '2026-10-14', s, null, true],
      ['CREATE_SESSION', '2026-10-15', null, shift.id, true],
      ['CREATE_SESSION', '2026-10-16', null, null, true], // sin turno ni jornada: unicidad por empleado + día operativo
    ];
    try {
      for (const [action, date, ws, sh, withEnd] of cases) {
        await c.query('BEGIN');
        const params = [F.orgId, F.VEN, p.id, date, action, ws, sh, withEnd ? new Date(Date.now() - 3_600_000) : null, F.kioskVEN.deviceId];
        expect(await pgError(c, base, params), `${action} primera`).toBeNull();
        expect((await pgError(c, base, params))?.code, `${action} duplicada`).toBe('23505');
        await c.query('ROLLBACK');
      }
      // columnas obligatorias por acción: una CREATE_SESSION con jornada, o un ajuste de pausa sin pausa, no existen
      await c.query('BEGIN');
      expect((await pgError(c, base, [F.orgId, F.VEN, p.id, '2026-10-14', 'SET_BREAK_START', s, null, null, F.kioskVEN.deviceId]))?.code).toBe('23514');
      expect((await pgError(c, base, [F.orgId, F.VEN, p.id, '2026-10-14', 'CREATE_SESSION', s, null, new Date(), F.kioskVEN.deviceId]))?.code).toBe('23514');
      // el día operativo guardado debe ser el de la jornada
      expect(await pgError(c, base, [F.orgId, F.VEN, p.id, '2026-10-01', 'SET_CLOCK_IN', s, null, null, F.kioskVEN.deviceId])).toMatchObject({ code: 'P0001', message: 'REQUEST_DATE_MISMATCH' });
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});

describe('aprobar y rechazar (D-71)', () => {
  it('aprobar aplica EXACTAMENTE lo solicitado con el mismo código de la corrección directa', async () => {
    const p = await F.employee('Aprob', F.VEN);
    const s = await lateDay(p, '2026-10-19');
    now = at('2026-10-19', '18:00');
    const { request: r } = await ask(p, { action: 'SET_CLOCK_IN', workSessionId: s, start: { date: '2026-10-19', time: '07:03' } });
    const v = (await session(s)).version;
    const res = await R.approve(F.managerCtx, F.manager, r.id, r.version, v);
    expect(res.request).toMatchObject({ status: 'APPROVED', correctionId: res.correctionId });
    expect((await session(s)).started_at.toISOString()).toBe(at('2026-10-19', '07:03').toISOString());
    const corr = (await pools.platform.query('SELECT * FROM attendance.corrections WHERE id = $1', [res.correctionId])).rows[0];
    expect(corr).toMatchObject({ request_id: r.id, action: 'SET_CLOCK_IN', corrected_by: F.managerCtx.actor.userId, reason: 'Llegué antes, el kiosco no respondía' });
    const d = await world.attendanceQuery.sessionDetail(F.ctx, F.admin, s);
    expect(d.incidents.find((i) => i.type === 'RETARDO')).toMatchObject({ status: 'RESOLVED', resolution: 'CORRECTED' }); // 3 min: ya no es retardo
    expect(d.recorded.map((e) => e.occurredAt.toISOString())).toContain(at('2026-10-19', '07:12').toISOString()); // físico intacto
    const audits = (await pools.platform.query(`SELECT action FROM audit.audit_log WHERE entity_id = $1 ORDER BY id`, [r.id])).rows.map((a) => a.action);
    expect(audits).toEqual(['correction_request.created', 'correction_request.approved']);
    // terminal e inmutable (servicio y BD)
    await expect(R.approve(F.ctx, F.admin, r.id, res.request.version, (await session(s)).version)).rejects.toMatchObject({ code: 'REQUEST_ALREADY_DECIDED' });
    const c = await pools.superuser.connect();
    try {
      await c.query('BEGIN');
      expect(await pgError(c, `UPDATE attendance.correction_requests SET status = 'CANCELLED', decided_at = now(), correction_id = NULL WHERE id = $1`, [r.id])).toMatchObject({ code: 'P0001', message: 'REQUEST_ALREADY_DECIDED' });
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('nadie aprueba su propia solicitud (encargada que también es empleada) — servicio y PostgreSQL', async () => {
    const s = await lateDay(F.lupe, '2026-10-20');
    now = at('2026-10-20', '18:00');
    const panel = await R.create(F.managerCtx, { channel: 'PANEL', userId: F.managerCtx.actor.userId! }, F.lupe.id, {
      clientRequestId: randomUUID(), action: 'SET_CLOCK_IN', workSessionId: s, start: { date: '2026-10-20', time: '07:00' }, reason: 'Llegué a tiempo',
    });
    expect(panel.request).toMatchObject({ channel: 'PANEL', status: 'PENDING' });
    await expect(R.approve(F.managerCtx, F.manager, panel.request.id, 1, (await session(s)).version)).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
    await expect(R.reject(F.managerCtx, F.manager, panel.request.id, 1, 'x')).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
    const c = await pools.superuser.connect();
    try {
      await c.query('BEGIN');
      const err = await pgError(c, `UPDATE attendance.correction_requests SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_reason = 'x' WHERE id = $1`, [panel.request.id, F.managerCtx.actor.userId]);
      expect(err).toMatchObject({ code: 'P0001', message: 'SELF_APPROVAL_FORBIDDEN' });
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    const ok = await R.approve(F.ctx, F.admin, panel.request.id, 1, (await session(s)).version);
    expect(ok.request.status).toBe('APPROVED');
  });

  it('alcance: la encargada de Venecia no ve ni decide solicitudes de San Marcos', async () => {
    const p = await F.employee('SanMarcos', F.SMA);
    now = at('2026-10-21', '08:00');
    const r0 = await F.punch(F.kioskSMA, p, 'CLOCK_IN');
    now = at('2026-10-21', '15:00');
    await F.punch(F.kioskSMA, p, 'CLOCK_OUT');
    now = at('2026-10-21', '18:00');
    const { request: r } = await ask(p, { action: 'SET_CLOCK_IN', workSessionId: r0.workSessionId, start: { date: '2026-10-21', time: '07:50' } }, F.kioskSMA);
    await expect(R.approve(F.managerCtx, F.manager, r.id, 1, 1)).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' });
    await expect(R.get(F.managerCtx, F.manager, r.id)).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' });
    expect((await R.list(F.managerCtx, F.manager, {})).some((x) => x.id === r.id)).toBe(false);
    expect((await R.list(F.ctx, F.admin, { status: 'PENDING' })).some((x) => x.id === r.id)).toBe(true);
  });

  it('si la jornada cambió desde la revisión, o la corrección ya no es válida, nada cambia y sigue PENDIENTE', async () => {
    const p = await F.employee('Cambio', F.VEN);
    const s = await lateDay(p, '2026-10-22');
    now = at('2026-10-22', '18:00');
    const { request: r } = await ask(p, { action: 'SET_CLOCK_IN', workSessionId: s, start: { date: '2026-10-22', time: '07:00' } });
    const seen = (await session(s)).version;
    await world.corrections.apply(F.ctx, F.admin, s, seen, { action: 'SET_CLOCK_OUT', at: { date: '2026-10-22', time: '15:05' } }, 'Ajuste del encargado');
    await expect(R.approve(F.ctx, F.admin, r.id, r.version, seen)).rejects.toMatchObject({ code: 'SESSION_VERSION_CONFLICT' });
    expect(await request(r.id)).toMatchObject({ status: 'PENDING', correction_id: null });
    // corrección imposible (Entrada después de la Salida) ⇒ error de dominio, sigue pendiente
    const { request: bad } = await ask(p, { action: 'SET_CLOCK_OUT', workSessionId: s, start: { date: '2026-10-22', time: '06:00' } });
    await expect(R.approve(F.ctx, F.admin, bad.id, bad.version, (await session(s)).version)).rejects.toMatchObject({ code: 'CORRECTION_ORDER_INVALID' });
    expect((await request(bad.id)).status).toBe('PENDING');
  });

  it('dos aprobaciones simultáneas: solo una aplica la corrección', async () => {
    const p = await F.employee('Doble', F.VEN);
    const s = await lateDay(p, '2026-10-23');
    now = at('2026-10-23', '18:00');
    const { request: r } = await ask(p, { action: 'SET_CLOCK_IN', workSessionId: s, start: { date: '2026-10-23', time: '07:05' } });
    const v = (await session(s)).version;
    const results = await Promise.allSettled([R.approve(F.ctx, F.admin, r.id, 1, v), R.approve(F.managerCtx, F.manager, r.id, 1, v)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await count(pools.platform, 'SELECT count(*) FROM attendance.corrections WHERE request_id = $1', [r.id])).toBe(1);
  });

  it('rechazar exige motivo; cancelar solo el propio solicitante mientras está pendiente', async () => {
    const p = await F.employee('Rech', F.VEN);
    const q = await F.employee('Ajeno', F.VEN);
    const s = await lateDay(p, '2026-10-26');
    now = at('2026-10-26', '18:00');
    const { request: r } = await ask(p, { action: 'SET_CLOCK_IN', workSessionId: s, start: { date: '2026-10-26', time: '07:00' } });
    await expect(R.reject(F.ctx, F.admin, r.id, 1, ' ')).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    const rej = await R.reject(F.ctx, F.admin, r.id, 1, 'La cámara muestra 07:12');
    expect(rej).toMatchObject({ status: 'REJECTED', decisionReason: 'La cámara muestra 07:12' });
    const { request: r2 } = await ask(p, { action: 'SET_CLOCK_OUT', workSessionId: s, start: { date: '2026-10-26', time: '15:30' } });
    await expect(K.cancelRequest(F.kioskVEN.ctx, F.kioskVEN, await ticketOf(F.kioskVEN, q), r2.id)).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' });
    const cancelled = await K.cancelRequest(F.kioskVEN.ctx, F.kioskVEN, await ticketOf(F.kioskVEN, p), r2.id);
    expect(cancelled.request.status).toBe('CANCELLED');
    // el contenido de una solicitud no se edita (privilegios de columna)
    const c = await pools.app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.organization_id', $1, true)`, [F.orgId]);
      expect((await pgError(c, `UPDATE attendance.correction_requests SET reason = 'otro' WHERE id = $1`, [r2.id]))?.code).toBe('42501');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});

describe('acciones especiales: pausa omitida y jornada no registrada', () => {
  it('ADD_BREAK solicitada y aprobada crea la pausa por corrección (sin evento físico)', async () => {
    const p = await F.employee('Comio', F.VEN);
    const s = await lateDay(p, '2026-10-27');
    now = at('2026-10-27', '18:00');
    const { request: r } = await ask(p, { action: 'ADD_BREAK', workSessionId: s, start: { date: '2026-10-27', time: '11:00' }, end: { date: '2026-10-27', time: '11:30' } });
    await R.approve(F.ctx, F.admin, r.id, 1, (await session(s)).version);
    const d = await world.attendanceQuery.sessionDetail(F.ctx, F.admin, s);
    expect(d.breaks).toEqual([expect.objectContaining({ origin: 'CORRECTION', durationMinutes: 30 })]);
    expect(d.recorded.map((e) => e.type)).toEqual(['CLOCK_IN', 'CLOCK_OUT']);
  });

  it('(C) CREATE_SESSION con turno: corrige la FALTA; si el turno se cancela antes de aprobar, la aprobación falla sin cambios', async () => {
    const p = await F.employee('Falto', F.VEN);
    const s1 = await F.publishedShift(p, F.VEN, '2026-10-28', '07:00', '15:00');
    const s2 = await F.publishedShift(p, F.VEN, '2026-10-29', '07:00', '15:00');
    now = at('2026-10-29', '16:00');
    await world.reconciler.reconcileOrganization(F.orgId);
    const { request: ok } = await ask(p, { action: 'CREATE_SESSION', shiftId: s1.id, start: { date: '2026-10-28', time: '07:00' }, end: { date: '2026-10-28', time: '15:00' } });
    expect(ok).toMatchObject({ shiftId: s1.id, branchId: F.VEN, operationalDate: '2026-10-28' });
    const approved = await R.approve(F.ctx, F.admin, ok.id, 1, null);
    const falta1 = (await pools.platform.query(`SELECT status, resolution FROM attendance.incidents WHERE shift_id = $1 AND type = 'FALTA'`, [s1.id])).rows[0];
    expect(falta1).toEqual({ status: 'RESOLVED', resolution: 'CORRECTED' });
    const types = (await pools.platform.query(`SELECT type FROM attendance.incidents WHERE work_session_id = $1`, [approved.workSessionId])).rows.map((x) => x.type);
    expect(types).not.toContain('SIN_TURNO_PROGRAMADO');

    const { request: late } = await ask(p, { action: 'CREATE_SESSION', shiftId: s2.id, start: { date: '2026-10-29', time: '07:00' }, end: { date: '2026-10-29', time: '15:00' } });
    const fresh = (await pools.platform.query('SELECT version FROM scheduling.shifts WHERE id = $1', [s2.id])).rows[0].version;
    await world.scheduling.cancelShift(F.ctx, F.admin, s2.id, fresh, 'Se le dio el día');
    await expect(R.approve(F.ctx, F.admin, late.id, 1, null)).rejects.toMatchObject({ code: 'SHIFT_NOT_OFFICIAL' });
    expect(await request(late.id)).toMatchObject({ status: 'PENDING', shift_id: s2.id });
    expect(await count(pools.platform, 'SELECT count(*) FROM attendance.work_sessions WHERE shift_id = $1', [s2.id])).toBe(0);
  });

  it('CREATE_SESSION sin turno: se ubica en la sucursal del kiosco y al aprobar genera SIN_TURNO_PROGRAMADO', async () => {
    const p = await F.employee('SinTurno', F.VEN);
    now = at('2026-10-30', '18:00');
    const { request: r } = await ask(p, { action: 'CREATE_SESSION', branchId: F.VEN, start: { date: '2026-10-30', time: '08:00' }, end: { date: '2026-10-30', time: '12:00' } });
    expect(r).toMatchObject({ shiftId: null, operationalDate: '2026-10-30' });
    const res = await R.approve(F.ctx, F.admin, r.id, 1, null);
    const types = (await pools.platform.query(`SELECT type FROM attendance.incidents WHERE work_session_id = $1 AND status = 'OPEN'`, [res.workSessionId])).rows.map((x) => x.type);
    expect(types).toEqual(['SIN_TURNO_PROGRAMADO']);
  });
});

describe('"Mis registros" (precisión G)', () => {
  it('solo la propia ficha y la ventana; el pase de otro dispositivo no sirve', async () => {
    const p = await F.employee('Mios', F.VEN);
    const other = await F.employee('Otra', F.VEN);
    const mine = await lateDay(p, '2026-11-02');
    await lateDay(other, '2026-11-02');
    await lateDay(p, '2026-10-20');
    await F.publishedShift(p, F.VEN, '2026-11-03', '07:00', '09:00');
    now = at('2026-11-03', '12:00');
    await world.reconciler.reconcileOrganization(F.orgId);
    const t = await ticketOf(F.kioskVEN, p);
    const rec = await K.myRecords(F.kioskVEN.ctx, F.kioskVEN, t);
    expect(rec.window).toEqual({ from: '2026-10-27', to: '2026-11-03', days: 7 });
    expect(rec.sessions.map((s) => s.id)).toEqual([mine]);
    expect(rec.absences).toEqual([expect.objectContaining({ operationalDate: '2026-11-03', startTime: '07:00' })]);
    expect(JSON.stringify(rec)).not.toContain(other.id);
    await expect(K.myRecords(F.kioskSMA.ctx, F.kioskSMA, t)).rejects.toMatchObject({ code: 'KIOSK_TICKET_INVALID' });
  });
});

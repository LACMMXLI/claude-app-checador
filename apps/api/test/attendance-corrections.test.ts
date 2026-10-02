import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AttendanceFixture, at, attendanceFixture } from './helpers/attendance-fixture.js';
import { count, pgError } from './helpers/sql.js';
import { buildWorld, openPools } from './helpers/world.js';

const pools = openPools();
let now = new Date('2026-09-01T12:00:00Z');
const world = buildWorld(pools, { clock: () => now });
const C = world.corrections;
const Q = world.attendanceQuery;
let F: AttendanceFixture;
let B: AttendanceFixture; // otro negocio

beforeAll(async () => {
  F = await attendanceFixture(world, (d) => (now = d));
  B = await attendanceFixture(world, (d) => (now = d));
});
afterAll(() => pools.close());

const version = async (sessionId: string) => (await pools.platform.query('SELECT version FROM attendance.work_sessions WHERE id = $1', [sessionId])).rows[0].version as number;
const shiftRow = async (id: string) => (await pools.platform.query('SELECT * FROM scheduling.shifts WHERE id = $1', [id])).rows[0];

/** Jornada de 07:12 a 15:00 ligada a un turno 07:00–15:00 (retardo 12). */
async function lateDay(person: { id: string; pin: string }, branchId: string, date: string) {
  const kiosk = branchId === F.VEN ? F.kioskVEN : F.kioskSMA;
  const shift = await F.publishedShift(person, branchId, date, '07:00', '15:00');
  now = at(date, '07:12');
  const r = await F.punch(kiosk, person, 'CLOCK_IN');
  now = at(date, '15:00');
  await F.punch(kiosk, person, 'CLOCK_OUT');
  now = at(date, '18:00');
  return { shift, sessionId: r.workSessionId };
}

describe('corrección de asistencia (D-51, D-52)', () => {
  it('(33)(34)(38) ADMIN corrige la Entrada 07:12 → 07:05: el turno no cambia, el evento físico se conserva y se ve antes/después', async () => {
    const p = await F.employee('Ari', F.VEN);
    const { shift, sessionId } = await lateDay(p, F.VEN, '2026-10-05');
    const shiftBefore = await shiftRow(shift.id);
    const eventsBefore = (await pools.platform.query('SELECT * FROM attendance.events WHERE work_session_id = $1 ORDER BY occurred_at', [sessionId])).rows;

    const res = await C.apply(F.ctx, F.admin, sessionId, await version(sessionId), { action: 'SET_CLOCK_IN', at: { date: '2026-10-05', time: '07:05' } }, 'El kiosco estaba ocupado; confirmado con cámara');
    expect(res.session.startedAt.toISOString()).toBe(at('2026-10-05', '07:05').toISOString());

    expect(await shiftRow(shift.id)).toEqual(shiftBefore); // (33) el turno es intocable desde asistencia
    expect((await pools.platform.query('SELECT * FROM attendance.events WHERE work_session_id = $1 ORDER BY occurred_at', [sessionId])).rows).toEqual(eventsBefore); // (34)

    const d = await Q.sessionDetail(F.ctx, F.admin, sessionId);
    expect(d.scheduled).toMatchObject({ startTime: '07:00', endTime: '15:00' }); // Programado
    expect(d.recorded.map((e) => [e.type, e.occurredAt.toISOString()])).toEqual([
      ['CLOCK_IN', at('2026-10-05', '07:12').toISOString()], // Registrado (físico)
      ['CLOCK_OUT', at('2026-10-05', '15:00').toISOString()],
    ]);
    expect(d.effective.startedAt.toISOString()).toBe(at('2026-10-05', '07:05').toISOString()); // Efectivo
    expect(d.effective.metrics.arrivalDeltaMinutes).toBe(5);
    expect(d.corrections).toHaveLength(1);
    expect(d.corrections[0]).toMatchObject({
      action: 'SET_CLOCK_IN',
      reason: 'El kiosco estaba ocupado; confirmado con cámara',
      originalValue: { startedAt: at('2026-10-05', '07:12').toISOString() },
      correctedValue: { startedAt: at('2026-10-05', '07:05').toISOString() },
      correctedBy: { displayName: 'Dueño' },
    });
    // el retardo de 12 ya no aplica con 5 (tolerancia 10): queda RESUELTO por corrección, no borrado
    const retardo = d.incidents.find((i) => i.type === 'RETARDO')!;
    expect(retardo).toMatchObject({ status: 'RESOLVED', resolution: 'CORRECTED' });
    expect(d.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['attendance.clock_in', 'attendance.clock_out', 'attendance.corrected']));
    expect(d.audit.find((a) => a.action === 'attendance.corrected')!.reason).toBe('El kiosco estaba ocupado; confirmado con cámara');
  });

  it('(35) toda corrección exige motivo', async () => {
    const p = await F.employee('Beni', F.VEN);
    const { sessionId } = await lateDay(p, F.VEN, '2026-10-06');
    for (const reason of ['', '   ']) {
      await expect(C.apply(F.ctx, F.admin, sessionId, await version(sessionId), { action: 'SET_CLOCK_IN', at: { date: '2026-10-06', time: '07:00' } }, reason)).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    }
    // y la BD también lo exige
    const c = await pools.superuser.connect();
    try {
      await c.query('BEGIN');
      const err = await pgError(c, `INSERT INTO attendance.corrections (organization_id, branch_id, employee_id, work_session_id, action, corrected_value, after, reason, corrected_by)
        VALUES ($1, $2, $3, $4, 'SET_CLOCK_IN', '{}', '{}', ' ', gen_random_uuid())`, [F.orgId, F.VEN, p.id, sessionId]);
      expect(err?.code).toBe('23514');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('(36) ENCARGADO corrige jornadas OCURRIDAS en su sucursal (aunque el empleado sea de otra) y no las de otra sucursal', async () => {
    const pedro = await F.employee('Pedro', F.SMA); // habitual San Marcos
    now = at('2026-10-07', '08:00');
    const inVen = await F.punch(F.kioskVEN, pedro, 'CLOCK_IN');
    now = at('2026-10-07', '16:00');
    await F.punch(F.kioskVEN, pedro, 'CLOCK_OUT');
    const ok = await C.apply(F.managerCtx, F.manager, inVen.workSessionId, await version(inVen.workSessionId), { action: 'SET_CLOCK_OUT', at: { date: '2026-10-07', time: '15:30' } }, 'Se fue a las 15:30');
    expect(ok.session.endedAt!.toISOString()).toBe(at('2026-10-07', '15:30').toISOString());

    const maria = await F.employee('María', F.VEN); // habitual Venecia, pero checó en San Marcos
    now = at('2026-10-08', '08:00');
    const inSma = await F.punch(F.kioskSMA, maria, 'CLOCK_IN');
    await expect(C.apply(F.managerCtx, F.manager, inSma.workSessionId, await version(inSma.workSessionId), { action: 'SET_CLOCK_IN', at: { date: '2026-10-08', time: '07:55' } }, 'x')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(Q.sessionDetail(F.managerCtx, F.manager, inSma.workSessionId)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('(37) ENCARGADO no puede corregir su propia jornada (servicio y PostgreSQL); ADMIN sí', async () => {
    now = at('2026-10-09', '08:00');
    const own = await F.punch(F.kioskVEN, F.lupe, 'CLOCK_IN');
    now = at('2026-10-09', '17:00');
    await F.punch(F.kioskVEN, F.lupe, 'CLOCK_OUT');
    await expect(C.apply(F.managerCtx, F.manager, own.workSessionId, await version(own.workSessionId), { action: 'SET_CLOCK_IN', at: { date: '2026-10-09', time: '07:00' } }, 'Llegué antes')).rejects.toMatchObject({ code: 'SELF_CORRECTION_FORBIDDEN' });
    expect((await Q.sessionDetail(F.managerCtx, F.manager, own.workSessionId)).permissions).toMatchObject({ canCorrect: false, isSelf: true });
    // aunque el servicio fallara, el trigger lo impide
    const c = await pools.superuser.connect();
    try {
      await c.query('BEGIN');
      const err = await pgError(c, `INSERT INTO attendance.corrections (organization_id, branch_id, employee_id, work_session_id, action, corrected_value, after, reason, corrected_by)
        VALUES ($1, $2, $3, $4, 'SET_CLOCK_IN', '{}', '{}', 'x', $5)`, [F.orgId, F.VEN, F.lupe.id, own.workSessionId, F.managerCtx.actor.userId]);
      expect(err).toMatchObject({ code: 'P0001', message: 'SELF_CORRECTION_FORBIDDEN' });
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    const byAdmin = await C.apply(F.ctx, F.admin, own.workSessionId, await version(own.workSessionId), { action: 'SET_CLOCK_IN', at: { date: '2026-10-09', time: '07:50' } }, 'Confirmado por el dueño');
    expect(byAdmin.correctionId).toBeTruthy();
  });

  it('(39) el negocio A jamás accede a jornadas del B (ni consultar ni corregir)', async () => {
    const p = await B.employee('Beto B', B.VEN);
    now = at('2026-10-12', '08:00');
    const r = await B.punch(B.kioskVEN, p, 'CLOCK_IN');
    await expect(Q.sessionDetail(F.ctx, F.admin, r.workSessionId)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(C.apply(F.ctx, F.admin, r.workSessionId, 1, { action: 'SET_CLOCK_IN', at: { date: '2026-10-12', time: '07:00' } }, 'x')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(Q.board(F.ctx, F.admin, B.VEN)).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
    const list = await Q.listSessions(F.ctx, F.admin, { from: '2026-10-01', to: '2026-10-31' });
    expect(list.some((s) => s.id === r.workSessionId)).toBe(false);
    await expect(C.createSession(F.ctx, F.admin, { employeeId: p.id, branchId: B.VEN, start: { date: '2026-10-11', time: '07:00' }, end: { date: '2026-10-11', time: '15:00' } }, 'x')).rejects.toBeTruthy();
    expect(await count(pools.platform, `SELECT count(*) FROM attendance.work_sessions WHERE employee_id = $1`, [p.id])).toBe(1);
  });

  it('cerrar por corrección una jornada en revisión, con la pausa olvidada: primero el regreso, luego la salida', async () => {
    const p = await F.employee('Cata', F.VEN);
    await F.publishedShift(p, F.VEN, '2026-10-13', '07:00', '15:00');
    now = at('2026-10-13', '07:00');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    now = at('2026-10-13', '12:00');
    await F.punch(F.kioskVEN, p, 'BREAK_START');
    now = at('2026-10-14', '06:00');
    await world.reconciler.reconcileOrganization(F.orgId);
    const reason = 'Se fue sin checar; lo confirmó el encargado de turno';
    await expect(C.apply(F.ctx, F.admin, r.workSessionId, await version(r.workSessionId), { action: 'SET_CLOCK_OUT', at: { date: '2026-10-13', time: '15:00' } }, reason)).rejects.toMatchObject({ code: 'BREAK_OPEN' });
    const brk = (await Q.sessionDetail(F.ctx, F.admin, r.workSessionId)).breaks[0]!;
    await C.apply(F.ctx, F.admin, r.workSessionId, await version(r.workSessionId), { action: 'SET_BREAK_END', breakId: brk.id, at: { date: '2026-10-13', time: '12:30' } }, reason);
    await C.apply(F.ctx, F.admin, r.workSessionId, await version(r.workSessionId), { action: 'SET_CLOCK_OUT', at: { date: '2026-10-13', time: '15:00' } }, reason);
    const d = await Q.sessionDetail(F.ctx, F.admin, r.workSessionId);
    expect(d.effective).toMatchObject({ status: 'CLOSED', metrics: { elapsedMinutes: 480, breakMinutes: 30, breakExcessMinutes: 0 } });
    expect(d.incidents.filter((i) => i.status === 'OPEN')).toEqual([]);
    expect(d.incidents.map((i) => [i.type, i.resolution]).sort()).toEqual([['REGRESO_COMIDA_FALTANTE', 'CORRECTED'], ['SALIDA_OLVIDADA', 'CORRECTED']]);
    expect(d.recorded.map((e) => e.type)).toEqual(['CLOCK_IN', 'BREAK_START']); // nada físico se inventó
  });

  it('concurrencia optimista: corregir con una versión vieja se rechaza', async () => {
    const p = await F.employee('Dino', F.VEN);
    const { sessionId } = await lateDay(p, F.VEN, '2026-10-15');
    const v = await version(sessionId);
    await C.apply(F.ctx, F.admin, sessionId, v, { action: 'SET_CLOCK_IN', at: { date: '2026-10-15', time: '07:10' } }, 'a');
    await expect(C.apply(F.ctx, F.admin, sessionId, v, { action: 'SET_CLOCK_IN', at: { date: '2026-10-15', time: '07:00' } }, 'b')).rejects.toMatchObject({ code: 'SESSION_VERSION_CONFLICT' });
  });

  it('asociar una jornada sin turno al turno oficial correcto (y la corrección no puede quedar en el futuro ni fuera de orden)', async () => {
    const p = await F.employee('Elio', F.VEN);
    now = at('2026-10-16', '06:45'); // fuera de la ventana de un turno que aún no estaba publicado
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    const shift = await F.publishedShift(p, F.VEN, '2026-10-16', '08:00', '16:00');
    now = at('2026-10-16', '09:00');
    await expect(C.apply(F.ctx, F.admin, r.workSessionId, await version(r.workSessionId), { action: 'SET_CLOCK_IN', at: { date: '2026-10-16', time: '10:00' } }, 'x')).rejects.toMatchObject({ code: 'CORRECTION_IN_FUTURE' });
    const linked = await C.apply(F.ctx, F.admin, r.workSessionId, await version(r.workSessionId), { action: 'LINK_SHIFT', shiftId: shift.id }, 'Su turno se publicó tarde');
    expect(linked.session.shiftId).toBe(shift.id);
    const d = await Q.sessionDetail(F.ctx, F.admin, r.workSessionId);
    expect(d.incidents.find((i) => i.type === 'SIN_TURNO_PROGRAMADO')).toMatchObject({ status: 'RESOLVED', resolution: 'CORRECTED' });
    expect(d.effective.metrics.arrivalDeltaMinutes).toBe(-75);
  });
});

describe('falta corregida (D-53) e incidencias', () => {
  it('turno con FALTA: crear por corrección la jornada que sí ocurrió deja la falta RESUELTA (nunca borrada)', async () => {
    const p = await F.employee('Fito', F.VEN);
    const shift = await F.publishedShift(p, F.VEN, '2026-10-19', '07:00', '15:00');
    now = at('2026-10-19', '16:00');
    await world.reconciler.reconcileOrganization(F.orgId);
    const [falta] = await Q.listIncidents(F.ctx, F.admin, { type: 'FALTA', from: '2026-10-19', to: '2026-10-19' });
    expect(falta).toMatchObject({ shift: { id: shift.id }, status: 'OPEN', canCorrect: true });
    const created = await C.createSession(
      F.ctx, F.admin,
      { employeeId: p.id, branchId: F.VEN, shiftId: shift.id, incidentId: falta!.id, start: { date: '2026-10-19', time: '07:20' }, end: { date: '2026-10-19', time: '15:00' } },
      'No había internet en la sucursal; lista de asistencia firmada',
    );
    const d = await Q.sessionDetail(F.ctx, F.admin, created.session.id);
    expect(d.effective).toMatchObject({ origin: 'CORRECTION', status: 'CLOSED', metrics: { arrivalDeltaMinutes: 20 } });
    expect(d.recorded).toEqual([]); // sin eventos físicos inventados
    expect(d.incidents.find((i) => i.type === 'FALTA')).toMatchObject({ status: 'RESOLVED', resolution: 'CORRECTED' });
    expect(d.incidents.find((i) => i.type === 'RETARDO')).toMatchObject({ status: 'OPEN' });
    expect(await count(pools.platform, `SELECT count(*) FROM attendance.incidents WHERE shift_id = $1 AND type = 'FALTA'`, [shift.id])).toBe(1);
    // ya no hay falta "abierta" y el reconciliador no vuelve a crearla
    await world.reconciler.reconcileOrganization(F.orgId);
    expect(await count(pools.platform, `SELECT count(*) FROM attendance.incidents WHERE shift_id = $1 AND type = 'FALTA'`, [shift.id])).toBe(1);
    // un turno que ya tiene jornada real no se puede cancelar
    const fresh = await shiftRow(shift.id);
    await expect(world.scheduling.cancelShift(F.ctx, F.admin, shift.id, fresh.version, 'x')).rejects.toMatchObject({ code: 'SHIFT_HAS_ATTENDANCE' });
  });

  it('resolver una incidencia exige permiso, motivo, versión y nunca la propia; queda en el historial', async () => {
    const p = await F.employee('Gina', F.VEN);
    const { sessionId } = await lateDay(p, F.VEN, '2026-10-20');
    const [retardo] = (await Q.sessionDetail(F.ctx, F.admin, sessionId)).incidents.filter((i) => i.type === 'RETARDO');
    await expect(C.resolveIncident(F.ctx, F.admin, retardo!.id, retardo!.version, 'JUSTIFIED', '')).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    const done = await C.resolveIncident(F.managerCtx, F.manager, retardo!.id, retardo!.version, 'JUSTIFIED', 'Cita médica con comprobante');
    expect(done).toMatchObject({ status: 'RESOLVED', resolution: 'JUSTIFIED' });
    await expect(C.resolveIncident(F.ctx, F.admin, retardo!.id, done.version, 'DISMISSED', 'x')).rejects.toMatchObject({ code: 'INCIDENT_ALREADY_RESOLVED' });
    // la BD no permite reabrir ni editar una incidencia resuelta
    const c = await pools.superuser.connect();
    try {
      await c.query('BEGIN');
      expect((await pgError(c, `UPDATE attendance.incidents SET status = 'OPEN', resolution = NULL, resolved_at = NULL WHERE id = $1`, [retardo!.id]))?.code).toBe('23001');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('historial por empleado: programado vs real, pausas, incidencias, correcciones y faltas (D-61)', async () => {
    const p = await F.employee('Hilda', F.VEN);
    const { sessionId } = await lateDay(p, F.VEN, '2026-10-21');
    await C.apply(F.ctx, F.admin, sessionId, await version(sessionId), { action: 'SET_CLOCK_IN', at: { date: '2026-10-21', time: '07:08' } }, 'Ajuste');
    const absent = await F.publishedShift(p, F.VEN, '2026-10-22', '07:00', '15:00');
    now = at('2026-10-22', '16:00');
    await world.reconciler.reconcileOrganization(F.orgId);
    const h = await Q.employeeHistory(F.ctx, F.admin, p.id, '2026-10-01', '2026-10-31');
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]).toMatchObject({
      operationalDate: '2026-10-21',
      branchName: 'Venecia',
      shift: { startTime: '07:00', endTime: '15:00' },
      metrics: { arrivalDeltaMinutes: 8, elapsedMinutes: 472 },
      corrections: { count: 1, lastBy: 'Dueño' },
    });
    expect(h.absences).toEqual([expect.objectContaining({ type: 'FALTA', operationalDate: '2026-10-22', shift: expect.objectContaining({ id: absent.id }) })]);
  });
});

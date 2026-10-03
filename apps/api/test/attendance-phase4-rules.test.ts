import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectedIncidents, policyFor } from '../src/modules/attendance/session-rules.js';
import { type AttendanceFixture, at, attendanceFixture } from './helpers/attendance-fixture.js';
import { count, pgError } from './helpers/sql.js';
import { buildWorld, openPools } from './helpers/world.js';

const pools = openPools();
let now = new Date('2026-09-01T12:00:00Z');
const world = buildWorld(pools, { clock: () => now });
const C = world.corrections;
let F: AttendanceFixture;

beforeAll(async () => {
  F = await attendanceFixture(world, (d) => (now = d));
});
afterAll(() => pools.close());

const open = async (sessionId: string) =>
  (await pools.platform.query(`SELECT type, details FROM attendance.incidents WHERE work_session_id = $1 AND status = 'OPEN' ORDER BY type`, [sessionId])).rows;
const types = async (sessionId: string) => (await open(sessionId)).map((r) => r.type);
const incidentsOfShift = async (shiftId: string) =>
  (await pools.platform.query(`SELECT * FROM attendance.incidents WHERE shift_id = $1 AND type = 'FALTA' ORDER BY created_at`, [shiftId])).rows;
const version = async (id: string) => (await pools.platform.query('SELECT version FROM attendance.work_sessions WHERE id = $1', [id])).rows[0].version as number;
const snapshotOf = async (id: string) => (await pools.platform.query('SELECT policy_snapshot FROM attendance.work_sessions WHERE id = $1', [id])).rows[0].policy_snapshot;

/** Jornada completa por kiosco en Venecia. */
async function day(person: { id: string; pin: string }, date: string, inTime: string, outDate: string, outTime: string) {
  now = at(date, inTime);
  const r = await F.punch(F.kioskVEN, person, 'CLOCK_IN');
  now = at(outDate, outTime);
  await F.punch(F.kioskVEN, person, 'CLOCK_OUT');
  return r.workSessionId;
}

describe('reglas puras de la Fase 4', () => {
  const shift = { startsAt: at('2026-10-05', '07:00'), endsAt: at('2026-10-05', '15:00') };
  const policy = { entryToleranceMin: 10, exitToleranceMin: 5, requireBreak: true, breakRequiredAfterMin: 360 };
  it('salida anticipada solo pasada la tolerancia; salir tarde nunca es incidencia', () => {
    const s = (out: string) => expectedIncidents({ startedAt: shift.startsAt, endedAt: at('2026-10-05', out) }, shift, [{ id: 'b', sequence: 1, endedAt: shift.startsAt, exceededMinutes: 0 }], policy);
    expect(s('14:55').has('SALIDA_ANTICIPADA')).toBe(false);
    expect(s('14:54').get('SALIDA_ANTICIPADA')).toEqual({ earlyMinutes: 6, toleranceMin: 5 });
    expect(s('16:30').has('SALIDA_ANTICIPADA')).toBe(false);
  });
  it('sin comida: solo con require_break, sin pausas cerradas y con la duración mínima', () => {
    const run = (out: string, p = policy, breaks: { id: string; sequence: number; endedAt: Date | null; exceededMinutes: number | null }[] = []) =>
      expectedIncidents({ startedAt: at('2026-10-05', '07:00'), endedAt: at('2026-10-05', out) }, null, breaks, p);
    expect(run('12:59').has('SIN_COMIDA')).toBe(false); // 5 h 59
    expect(run('13:00').get('SIN_COMIDA')).toEqual({ elapsedMinutes: 360, breakRequiredAfterMin: 360 });
    expect(run('15:00', { ...policy, requireBreak: false }).has('SIN_COMIDA')).toBe(false);
    expect(run('15:00', policy, [{ id: 'b', sequence: 1, endedAt: at('2026-10-05', '11:00'), exceededMinutes: 0 }]).has('SIN_COMIDA')).toBe(false);
  });
  it('snapshot primero; la política actual solo cubre valores que una jornada histórica no congeló', () => {
    const current = { entryToleranceMin: 99, exitToleranceMin: 99, requireBreak: true, breakRequiredAfterMin: 99 } as never;
    expect(policyFor({ entryToleranceMin: 10, exitToleranceMin: 5, requireBreak: false, breakRequiredAfterMin: 0 }, current)).toEqual({ entryToleranceMin: 10, exitToleranceMin: 5, requireBreak: false, breakRequiredAfterMin: 0 });
    expect(policyFor({ entryToleranceMin: 10 }, current)).toEqual({ entryToleranceMin: 10, exitToleranceMin: 99, requireBreak: true, breakRequiredAfterMin: 99 });
  });
});

describe('SALIDA_ANTICIPADA (D-67)', () => {
  it('con tolerancia 5: 14:56 no genera; 14:54 sí (6 min reales); nocturno compara contra el fin del día siguiente', async () => {
    const a = await F.employee('Anti', F.VEN);
    const b = await F.employee('Beto', F.VEN);
    const n = await F.employee('Noche', F.VEN);
    for (const p of [a, b, n]) await world.policies.setOverride(F.ctx, 'EMPLOYEE', p.id, { exitToleranceMin: 5 });
    await F.publishedShift(a, F.VEN, '2026-10-05', '07:00', '15:00');
    await F.publishedShift(b, F.VEN, '2026-10-05', '07:00', '15:00');
    await F.publishedShift(n, F.VEN, '2026-10-05', '19:00', '03:00');
    expect(await types(await day(a, '2026-10-05', '07:00', '2026-10-05', '14:56'))).toEqual([]);
    const sb = await day(b, '2026-10-05', '07:00', '2026-10-05', '14:54');
    expect(await open(sb)).toEqual([{ type: 'SALIDA_ANTICIPADA', details: { earlyMinutes: 6, toleranceMin: 5 } }]);
    const sn = await day(n, '2026-10-05', '19:00', '2026-10-06', '02:30');
    expect((await open(sn))[0]).toMatchObject({ type: 'SALIDA_ANTICIPADA', details: { earlyMinutes: 30 } });
  });

  it('la tolerancia usada es la del SNAPSHOT de la jornada: cambiar la política después no reinterpreta', async () => {
    const p = await F.employee('Snap', F.VEN);
    await world.policies.setOverride(F.ctx, 'EMPLOYEE', p.id, { exitToleranceMin: 5, requireBreak: true, breakRequiredAfterMin: 600 });
    await F.publishedShift(p, F.VEN, '2026-10-06', '07:00', '15:00');
    now = at('2026-10-06', '07:00');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    expect(await snapshotOf(r.workSessionId)).toMatchObject({ exitToleranceMin: 5, entryToleranceMin: 10, requireBreak: true, breakRequiredAfterMin: 600, breakAllowedMin: 35, breakToleranceMin: 0 });
    await world.policies.setOverride(F.ctx, 'EMPLOYEE', p.id, { exitToleranceMin: 60 });
    now = at('2026-10-06', '14:50');
    await F.punch(F.kioskVEN, p, 'CLOCK_OUT');
    expect(await types(r.workSessionId)).toEqual(['SALIDA_ANTICIPADA']);
  });

  it('corregir la salida la resuelve como CORRECTED; sin turno o saliendo tarde no aplica', async () => {
    const p = await F.employee('Corr', F.VEN);
    await F.publishedShift(p, F.VEN, '2026-10-07', '07:00', '15:00');
    const s = await day(p, '2026-10-07', '07:00', '2026-10-07', '14:00');
    expect(await types(s)).toEqual(['SALIDA_ANTICIPADA']);
    now = at('2026-10-07', '18:00');
    await C.apply(F.ctx, F.admin, s, await version(s), { action: 'SET_CLOCK_OUT', at: { date: '2026-10-07', time: '15:02' } }, 'Se fue a las 15:02; el kiosco falló');
    expect(await types(s)).toEqual([]);
    const resolved = (await pools.platform.query(`SELECT resolution, resolution_source FROM attendance.incidents WHERE work_session_id = $1 AND type = 'SALIDA_ANTICIPADA'`, [s])).rows;
    expect(resolved).toEqual([{ resolution: 'CORRECTED', resolution_source: 'CORRECTION' }]);
    const free = await F.employee('Libre', F.VEN);
    expect(await types(await day(free, '2026-10-08', '07:00', '2026-10-08', '08:00'))).toEqual(['SIN_TURNO_PROGRAMADO']);
  });
});

describe('SIN_COMIDA (D-68) y pausa omitida (D-69)', () => {
  it('require_break + 360: 6 h sin pausa genera; 5 h 59 no; ADD_BREAK la resuelve sin tocar la duración ni crear eventos', async () => {
    const p = await F.employee('Comida', F.VEN);
    const q = await F.employee('Corta', F.VEN);
    for (const x of [p, q]) await world.policies.setOverride(F.ctx, 'EMPLOYEE', x.id, { requireBreak: true, breakRequiredAfterMin: 360 });
    const short = await day(q, '2026-10-09', '07:00', '2026-10-09', '12:59');
    expect(await types(short)).toEqual(['SIN_TURNO_PROGRAMADO']);
    const s = await day(p, '2026-10-09', '07:00', '2026-10-09', '13:00');
    expect((await open(s)).find((i) => i.type === 'SIN_COMIDA')!.details).toEqual({ elapsedMinutes: 360, breakRequiredAfterMin: 360 });

    const eventsBefore = await count(pools.platform, 'SELECT count(*) FROM attendance.events WHERE work_session_id = $1', [s]);
    now = at('2026-10-09', '18:00');
    const res = await C.apply(F.ctx, F.admin, s, await version(s), { action: 'ADD_BREAK', start: { date: '2026-10-09', time: '10:00' }, end: { date: '2026-10-09', time: '10:40' } }, 'Comió y olvidó checar');
    expect(res.session.breaks).toEqual([expect.objectContaining({ sequence: 1, durationMinutes: 40, exceededMinutes: 5 })]);
    expect(await types(s)).toEqual(['COMIDA_EXCEDIDA', 'SIN_TURNO_PROGRAMADO']);
    expect(await count(pools.platform, 'SELECT count(*) FROM attendance.events WHERE work_session_id = $1', [s])).toBe(eventsBefore); // nada físico inventado
    const d = await world.attendanceQuery.sessionDetail(F.ctx, F.admin, s);
    expect(d.effective.metrics).toMatchObject({ elapsedMinutes: 360, breakMinutes: 40, breakExcessMinutes: 5 }); // la pausa no se descuenta
    expect(d.breaks[0]).toMatchObject({ origin: 'CORRECTION' });
    expect(d.corrections.at(-1)).toMatchObject({ action: 'ADD_BREAK', reason: 'Comió y olvidó checar', correctedBy: { displayName: 'Dueño' } });
    expect(d.incidents.find((i) => i.type === 'SIN_COMIDA')).toMatchObject({ status: 'RESOLVED', resolution: 'CORRECTED' });
    expect(d.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['attendance.corrected', 'attendance.break_added']));
  });

  it('ADD_BREAK valida cruces, límites de la jornada y horas futuras; puede exceder max_breaks (queda señalado)', async () => {
    const p = await F.employee('Pausas', F.VEN);
    now = at('2026-10-12', '07:00');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    now = at('2026-10-12', '11:00');
    await F.punch(F.kioskVEN, p, 'BREAK_START');
    now = at('2026-10-12', '11:30');
    await F.punch(F.kioskVEN, p, 'BREAK_END');
    now = at('2026-10-12', '15:00');
    await F.punch(F.kioskVEN, p, 'CLOCK_OUT');
    const s = r.workSessionId;
    now = at('2026-10-12', '20:00');
    const add = (start: string, end: string, date = '2026-10-12') =>
      C.apply(F.ctx, F.admin, s, 0, { action: 'ADD_BREAK', start: { date, time: start }, end: { date, time: end } }, 'x');
    const v = await version(s);
    const addV = (start: string, end: string, date = '2026-10-12') =>
      C.apply(F.ctx, F.admin, s, v, { action: 'ADD_BREAK', start: { date, time: start }, end: { date, time: end } }, 'Pausa no registrada');
    await expect(add('13:00', '13:10')).rejects.toMatchObject({ code: 'SESSION_VERSION_CONFLICT' });
    await expect(addV('11:20', '11:50')).rejects.toMatchObject({ code: 'BREAK_OVERLAP' });
    await expect(addV('06:50', '07:10')).rejects.toMatchObject({ code: 'CORRECTION_ORDER_INVALID' });
    await expect(addV('14:50', '15:10')).rejects.toMatchObject({ code: 'CORRECTION_ORDER_INVALID' });
    await expect(addV('13:10', '13:00')).rejects.toMatchObject({ code: 'CORRECTION_ORDER_INVALID' });
    const ok = await addV('13:00', '13:10');
    expect(ok.session.breaks.map((b) => b.sequence)).toEqual([1, 2]);
    const corr = (await pools.platform.query(`SELECT corrected_value FROM attendance.corrections WHERE work_session_id = $1 AND action = 'ADD_BREAK'`, [s])).rows[0];
    expect(corr.corrected_value).toMatchObject({ exceedsMaxBreaks: true }); // max_breaks = 1: se permite y queda señalado
    // con la jornada abierta y una pausa abierta no se agrega otra
    const o = await F.employee('Abierta', F.VEN);
    now = at('2026-10-13', '07:00');
    const r2 = await F.punch(F.kioskVEN, o, 'CLOCK_IN');
    now = at('2026-10-13', '12:00');
    await F.punch(F.kioskVEN, o, 'BREAK_START');
    await expect(C.apply(F.ctx, F.admin, r2.workSessionId, await version(r2.workSessionId), { action: 'ADD_BREAK', start: { date: '2026-10-13', time: '09:00' }, end: { date: '2026-10-13', time: '09:10' } }, 'x')).rejects.toMatchObject({ code: 'BREAK_OPEN' });
    await expect(C.apply(F.ctx, F.admin, r2.workSessionId, await version(r2.workSessionId), { action: 'ADD_BREAK', start: { date: '2026-10-13', time: '12:30' }, end: { date: '2026-10-13', time: '12:40' } }, 'x')).rejects.toMatchObject({ code: 'CORRECTION_IN_FUTURE' });
  });
});

describe('FALTA anulada por el plan (D-66)', () => {
  async function falta(name: string, date: string) {
    const p = await F.employee(name, F.VEN);
    const s = await F.publishedShift(p, F.VEN, date, '07:00', '09:00');
    now = at(date, '10:00');
    await world.reconciler.reconcileOrganization(F.orgId);
    const [f] = await incidentsOfShift(s.id);
    expect(f).toMatchObject({ status: 'OPEN' });
    const shift = (await pools.platform.query('SELECT version FROM scheduling.shifts WHERE id = $1', [s.id])).rows[0];
    return { p, s: { ...s, version: shift.version as number } };
  }

  it('cancelar el turno ANULA la falta (sistema, motivo, auditoría); nunca se borra ni se vuelve a crear', async () => {
    const { s } = await falta('Cancelado', '2026-10-14');
    await world.scheduling.cancelShift(F.ctx, F.admin, s.id, s.version, 'Se le dio el día');
    const rows = await incidentsOfShift(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'RESOLVED', resolution: 'VOIDED', resolution_source: 'SYSTEM', resolution_reason: 'SHIFT_CANCELLED: Se le dio el día', resolved_by: F.ctx.actor.userId });
    const audit = (await pools.platform.query(`SELECT actor_type, actor_user_id, reason FROM audit.audit_log WHERE action = 'attendance.incident_voided' AND entity_id = $1`, [rows[0].id])).rows;
    expect(audit).toEqual([{ actor_type: 'SYSTEM', actor_user_id: F.ctx.actor.userId, reason: 'SHIFT_CANCELLED: Se le dio el día' }]);
    now = at('2026-10-15', '10:00');
    await world.reconciler.reconcileOrganization(F.orgId);
    expect(await incidentsOfShift(s.id)).toHaveLength(1);
  });

  it('reasignar el turno a otra persona anula la falta y la reconciliación genera la del nuevo dueño', async () => {
    const { p, s } = await falta('Primero', '2026-10-16');
    const other = await F.employee('Segundo', F.VEN);
    now = at('2026-10-16', '11:00');
    await world.scheduling.updateShift(F.ctx, F.admin, s.id, s.version, { employeeId: other.id }, 'Lo cubrió otra persona');
    await world.reconciler.reconcileOrganization(F.orgId);
    const rows = await incidentsOfShift(s.id);
    expect(rows.map((r) => [r.employee_id, r.status, r.resolution, r.resolution_reason])).toEqual([
      [p.id, 'RESOLVED', 'VOIDED', 'SHIFT_REASSIGNED'],
      [other.id, 'OPEN', null, null],
    ]);
  });

  it('reprogramar a futuro anula; reprogramar dentro del pasado la deja vigente; una falta ya resuelta no se toca', async () => {
    const a = await falta('Futuro', '2026-10-19');
    now = at('2026-10-19', '11:00');
    await world.scheduling.updateShift(F.ctx, F.admin, a.s.id, a.s.version, { startTime: '17:00', endTime: '20:00' }, 'Se movió a la tarde');
    expect((await incidentsOfShift(a.s.id))[0]).toMatchObject({ resolution: 'VOIDED', resolution_reason: 'SHIFT_RESCHEDULED' });

    const b = await falta('Pasado', '2026-10-20');
    now = at('2026-10-20', '11:00');
    await world.scheduling.updateShift(F.ctx, F.admin, b.s.id, b.s.version, { startTime: '07:30', endTime: '09:30' }, 'Ajuste');
    expect((await incidentsOfShift(b.s.id))[0]).toMatchObject({ status: 'OPEN' });

    const c = await falta('Justificada', '2026-10-21');
    const [inc] = await incidentsOfShift(c.s.id);
    await C.resolveIncident(F.ctx, F.admin, inc.id, inc.version, 'JUSTIFIED', 'Incapacidad');
    await world.scheduling.cancelShift(F.ctx, F.admin, c.s.id, c.s.version, 'Cancelado después');
    expect((await incidentsOfShift(c.s.id))[0]).toMatchObject({ resolution: 'JUSTIFIED', resolution_source: 'USER' });
  });

  it('PostgreSQL impide una FALTA para un turno cancelado (guarda) y la reconciliación no la crea aunque compita con la cancelación', async () => {
    const p = await F.employee('Carrera', F.VEN);
    const s = await F.publishedShift(p, F.VEN, '2026-10-22', '07:00', '09:00');
    const c = await pools.superuser.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE scheduling.shifts SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = 'carrera' WHERE id = $1`, [s.id]);
      now = at('2026-10-22', '10:00');
      const reconciling = world.reconciler.reconcileOrganization(F.orgId); // se bloquea en el FOR SHARE del turno
      await new Promise((r) => setTimeout(r, 300));
      await c.query('COMMIT');
      await reconciling;
    } finally {
      c.release();
    }
    expect(await incidentsOfShift(s.id)).toEqual([]);
    const g = await pools.superuser.connect();
    try {
      await g.query('BEGIN');
      const err = await pgError(g, `INSERT INTO attendance.incidents (organization_id, branch_id, employee_id, shift_id, operational_date, type, detected_by)
        VALUES ($1, $2, $3, $4, '2026-10-22', 'FALTA', 'RECONCILER')`, [F.orgId, F.VEN, p.id, s.id]);
      expect(err).toMatchObject({ code: 'P0001', message: 'FALTA_NOT_APPLICABLE' });
      await g.query('ROLLBACK');
    } finally {
      g.release();
    }
  });
});

describe('CREATE_SESSION (D-72)', () => {
  it('sin turno: genera SIN_TURNO_PROGRAMADO (y SIN_ASIGNACION_SUCURSAL si aplica); con turno: no, y resuelve la FALTA', async () => {
    const p = await F.employee('Manual', F.VEN);
    now = at('2026-10-23', '20:00');
    const free = await C.createSession(F.ctx, F.admin, { employeeId: p.id, branchId: F.SMA, start: { date: '2026-10-23', time: '08:00' }, end: { date: '2026-10-23', time: '12:00' } }, 'Trabajó sin internet en San Marcos');
    expect(await types(free.session.id)).toEqual(['SIN_ASIGNACION_SUCURSAL', 'SIN_TURNO_PROGRAMADO']);

    const q = await F.employee('ConTurno', F.VEN);
    const s = await F.publishedShift(q, F.VEN, '2026-10-24', '07:00', '15:00');
    now = at('2026-10-24', '16:00');
    await world.reconciler.reconcileOrganization(F.orgId);
    const created = await C.createSession(F.ctx, F.admin, { employeeId: q.id, branchId: F.VEN, shiftId: s.id, start: { date: '2026-10-24', time: '07:00' }, end: { date: '2026-10-24', time: '14:30' } }, 'Lista firmada');
    expect(await types(created.session.id)).toEqual(['SALIDA_ANTICIPADA']); // tolerancia 0 de plataforma
    expect((await incidentsOfShift(s.id))[0]).toMatchObject({ status: 'RESOLVED', resolution: 'CORRECTED', resolution_source: 'CORRECTION' });
  });

  it('con un turno que dejó de ser oficial (cancelado) falla sin crear nada', async () => {
    const p = await F.employee('Cancelada', F.VEN);
    const s = await F.publishedShift(p, F.VEN, '2026-10-26', '07:00', '15:00');
    await world.scheduling.cancelShift(F.ctx, F.admin, s.id, s.version, 'No vino nadie');
    now = at('2026-10-26', '18:00');
    await expect(C.createSession(F.ctx, F.admin, { employeeId: p.id, branchId: F.VEN, shiftId: s.id, start: { date: '2026-10-26', time: '07:00' }, end: { date: '2026-10-26', time: '15:00' } }, 'x')).rejects.toMatchObject({ code: 'SHIFT_NOT_OFFICIAL' });
    expect(await count(pools.platform, 'SELECT count(*) FROM attendance.work_sessions WHERE employee_id = $1', [p.id])).toBe(0);
  });
});

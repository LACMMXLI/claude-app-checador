import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AttendanceFixture, at, attendanceFixture } from './helpers/attendance-fixture.js';
import { count } from './helpers/sql.js';
import { buildWorld, openPools } from './helpers/world.js';

const pools = openPools();
let now = new Date('2026-09-01T12:00:00Z');
const world = buildWorld(pools, { clock: () => now });
const R = world.reconciler;
let F: AttendanceFixture;

beforeAll(async () => {
  F = await attendanceFixture(world, (d) => (now = d));
});
afterAll(() => pools.close());

const session = async (id: string) =>
  (await pools.platform.query('SELECT ws.*, ws.operational_date::text AS operational_date FROM attendance.work_sessions ws WHERE id = $1', [id])).rows[0];
const incidentsOf = async (where: string, id: string) =>
  (await pools.platform.query(`SELECT type, status, details FROM attendance.incidents WHERE ${where} = $1 ORDER BY type`, [id])).rows;
const faltas = (shiftId: string) => count(pools.platform, `SELECT count(*) FROM attendance.incidents WHERE shift_id = $1 AND type = 'FALTA'`, [shiftId]);
const boardRow = async (branchId: string, date: string, employeeId: string) =>
  (await world.attendanceQuery.board(F.ctx, F.admin, branchId, date)).rows.find((r) => r.employee.id === employeeId)!;

describe('jornadas abiertas: nunca se inventa la Salida (D-9, D-47, D-48)', () => {
  it('(26)(27) turno 19:00–03:00 abierto al corte 05:00 ⇒ SALIDA_OLVIDADA + revisión, SIN hora de salida inventada', async () => {
    const p = await F.employee('Abel', F.VEN);
    await F.publishedShift(p, F.VEN, '2026-11-09', '19:00', '03:00');
    now = at('2026-11-09', '19:00');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    now = at('2026-11-10', '04:59');
    await R.reconcileOrganization(F.orgId);
    expect(await session(r.workSessionId)).toMatchObject({ status: 'OPEN' }); // antes del corte aún puede marcar Salida
    now = at('2026-11-10', '05:00');
    const result = await R.reconcileOrganization(F.orgId);
    expect(result.forgottenExits).toBeGreaterThanOrEqual(1);
    const s = await session(r.workSessionId);
    expect(s).toMatchObject({ status: 'REVIEW', ended_at: null }); // ni 03:00 ni 05:00
    expect(await count(pools.platform, `SELECT count(*) FROM attendance.events WHERE work_session_id = $1 AND type = 'CLOCK_OUT'`, [r.workSessionId])).toBe(0);
    expect(await incidentsOf('work_session_id', r.workSessionId)).toEqual([
      { type: 'SALIDA_OLVIDADA', status: 'OPEN', details: expect.objectContaining({ cutoff: '05:00:00' }) },
    ]);
    // el tablero lo muestra como jornada con problema que requiere corrección
    expect(await boardRow(F.VEN, '2026-11-09', p.id)).toMatchObject({ state: 'NEEDS_REVIEW', requiresCorrection: true });
  });

  it('una jornada en revisión no bloquea la siguiente Entrada (RN-OPE-06) y se detecta también al identificarse (RN-OPE-05)', async () => {
    const p = await F.employee('Bere', F.VEN);
    await F.publishedShift(p, F.VEN, '2026-11-11', '07:00', '15:00');
    now = at('2026-11-11', '07:00');
    const first = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    // al día siguiente, SIN que haya corrido la reconciliación, vuelve a checar
    now = at('2026-11-12', '07:00');
    const state = await world.kioskAttendance.identify(F.kioskVEN.ctx, F.kioskVEN, p.pin);
    expect(state).toMatchObject({ status: 'NONE', actions: ['CLOCK_IN'] });
    expect(await session(first.workSessionId)).toMatchObject({ status: 'REVIEW', ended_at: null });
    const second = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    expect(second.workSessionId).not.toBe(first.workSessionId);
  });

  it('(28) jornada sin turno abierta más de max_open_session_minutes (960) ⇒ revisión e incidencia; no se inventa la salida', async () => {
    const p = await F.employee('Ciro', F.VEN);
    now = at('2026-11-13', '08:00');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    now = at('2026-11-13', '23:59'); // 959 min
    await R.reconcileOrganization(F.orgId);
    expect((await session(r.workSessionId)).status).toBe('OPEN');
    now = at('2026-11-14', '00:00'); // 960 min
    await R.reconcileOrganization(F.orgId);
    expect(await session(r.workSessionId)).toMatchObject({ status: 'REVIEW', ended_at: null });
    expect((await incidentsOf('work_session_id', r.workSessionId)).map((i) => i.type)).toEqual(['JORNADA_ABIERTA_EXCEDIDA', 'SIN_TURNO_PROGRAMADO']);
  });

  it('pausa abierta al pasar a revisión ⇒ REGRESO_COMIDA_FALTANTE (D-50)', async () => {
    const p = await F.employee('Dora', F.VEN);
    await F.publishedShift(p, F.VEN, '2026-11-16', '07:00', '15:00');
    now = at('2026-11-16', '07:00');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    now = at('2026-11-16', '12:00');
    await F.punch(F.kioskVEN, p, 'BREAK_START');
    now = at('2026-11-17', '05:00');
    const result = await R.reconcileOrganization(F.orgId);
    expect(result.openBreaks).toBeGreaterThanOrEqual(1);
    expect((await incidentsOf('work_session_id', r.workSessionId)).map((i) => i.type)).toEqual(['REGRESO_COMIDA_FALTANTE', 'SALIDA_OLVIDADA']);
    expect((await pools.platform.query(`SELECT ended_at FROM attendance.breaks WHERE work_session_id = $1`, [r.workSessionId])).rows[0].ended_at).toBeNull();
  });
});

describe('ausente ≠ falta (D-4, D-43) y faltas definitivas (D-44)', () => {
  it('(29)(30) a +60 min es "Ausente / no ha llegado" (no falta); si llega a las 09:30 pasa a Trabajando con 150 de retardo', async () => {
    const p = await F.employee('Elsa', F.VEN);
    const shift = await F.publishedShift(p, F.VEN, '2026-11-18', '07:00', '15:00');
    now = at('2026-11-18', '07:05');
    expect((await boardRow(F.VEN, '2026-11-18', p.id)).state).toBe('WITHIN_TOLERANCE');
    now = at('2026-11-18', '07:30');
    expect((await boardRow(F.VEN, '2026-11-18', p.id)).state).toBe('LATE_NOT_ARRIVED');
    now = at('2026-11-18', '08:00');
    expect((await boardRow(F.VEN, '2026-11-18', p.id)).state).toBe('ABSENT_NOT_ARRIVED');
    await R.reconcileOrganization(F.orgId);
    expect(await faltas(shift.id)).toBe(0); // (29) todavía no es falta
    now = at('2026-11-18', '09:30');
    await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    const row = await boardRow(F.VEN, '2026-11-18', p.id);
    expect(row).toMatchObject({ state: 'WORKING', arrivalDeltaMinutes: 150, late: true }); // (30)
    now = at('2026-11-18', '16:00');
    await R.reconcileOrganization(F.orgId);
    expect(await faltas(shift.id)).toBe(0); // un retardo con Entrada real nunca se vuelve falta
  });

  it('(31)(32) turno publicado sin Entrada ⇒ UNA sola FALTA, aunque la reconciliación corra varias veces (y en paralelo)', async () => {
    const p = await F.employee('Fabi', F.VEN);
    const shift = await F.publishedShift(p, F.VEN, '2026-11-19', '07:00', '15:00');
    now = at('2026-11-19', '14:59');
    await R.reconcileOrganization(F.orgId);
    expect(await faltas(shift.id)).toBe(0);
    now = at('2026-11-19', '15:00');
    const first = await R.reconcileOrganization(F.orgId);
    expect(first.absences).toBeGreaterThanOrEqual(1);
    const again = await R.reconcileOrganization(F.orgId);
    await Promise.all([R.reconcileOrganization(F.orgId), R.reconcileOrganization(F.orgId)]);
    expect(await faltas(shift.id)).toBe(1);
    expect(again.absences).toBe(0);
    const [falta] = await incidentsOf('shift_id', shift.id);
    expect(falta).toMatchObject({ type: 'FALTA', status: 'OPEN' });
    const row = (await pools.platform.query(`SELECT branch_id, employee_id, operational_date::text AS d, work_session_id FROM attendance.incidents WHERE shift_id = $1`, [shift.id])).rows[0];
    expect(row).toEqual({ branch_id: F.VEN, employee_id: p.id, d: '2026-11-19', work_session_id: null });
    expect((await boardRow(F.VEN, '2026-11-19', p.id)).state).toBe('MISSED');
  });

  it('turnos CANCELADOS o en BORRADOR nunca generan ausencia ni falta (D-62, D-63)', async () => {
    const p = await F.employee('Gabo', F.VEN);
    const cancelled = await F.publishedShift(p, F.VEN, '2026-11-20', '07:00', '15:00');
    await world.scheduling.cancelShift(F.ctx, F.admin, cancelled.id, cancelled.version, 'Permiso');
    const draft = await F.draftShift(p, F.VEN, '2027-01-04', '07:00', '15:00');
    now = at('2027-01-05', '12:00');
    await R.reconcileOrganization(F.orgId);
    expect(await faltas(cancelled.id)).toBe(0);
    expect(await faltas(draft.id)).toBe(0);
    const board = await world.attendanceQuery.board(F.ctx, F.admin, F.VEN, '2027-01-04');
    expect(board.rows.find((r) => r.employee.id === p.id)).toBeUndefined();
  });

  it('reconcileAll procesa cada negocio activo en su propio contexto', async () => {
    now = new Date('2026-09-02T12:00:00Z'); // fecha temprana: no altera datos de otras pruebas de la base compartida
    const { results, errors } = await R.reconcileAll();
    expect(errors).toEqual([]);
    expect(results.map((r) => r.organizationId)).toContain(F.orgId);
  });
});

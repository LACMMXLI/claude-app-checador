import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operationalDate, operationalDateIn, operationalDayWindow } from '../src/common/operational-day.js';
import { localToUtc } from '../src/common/zoned-time.js';
import { toCsv } from '../src/modules/reports/export.js';
import { type AttendanceFixture, TZ, at, attendanceFixture } from './helpers/attendance-fixture.js';
import { pgError } from './helpers/sql.js';
import { buildWorld, openPools } from './helpers/world.js';

/**
 * D-78 · Un solo día operativo: mientras no llega la hora de corte (política del negocio/sucursal, en su zona IANA),
 * todo pertenece al día operativo anterior. Fatboy: America/Tijuana, corte 05:00 (default de plataforma).
 */
const pools = openPools();
let now = new Date('2026-09-01T12:00:00Z');
const world = buildWorld(pools, { clock: () => now });
let F: AttendanceFixture;

/** Instante exacto (con segundos) de una hora local de Tijuana. */
const atSec = (date: string, time: string) => new Date(localToUtc(date, time.slice(0, 5), TZ).getTime() + Number(time.slice(6, 8) || 0) * 1000);
const FATBOY = { timezone: TZ, cutoff: '05:00:00' };

beforeAll(async () => {
  F = await attendanceFixture(world, (d) => (now = d));
});
afterAll(() => pools.close());

describe('regla canónica (pura)', () => {
  it('fronteras del ejemplo aprobado: 23:30 y 01:30 y 04:59:59 ⇒ día anterior; 05:00:00 ⇒ día nuevo', () => {
    expect(operationalDateIn(atSec('2026-10-02', '23:30:00'), FATBOY)).toBe('2026-10-02');
    expect(operationalDateIn(atSec('2026-10-03', '00:00:00'), FATBOY)).toBe('2026-10-02');
    expect(operationalDateIn(atSec('2026-10-03', '01:30:00'), FATBOY)).toBe('2026-10-02');
    expect(operationalDateIn(atSec('2026-10-03', '04:59:59'), FATBOY)).toBe('2026-10-02');
    expect(operationalDateIn(atSec('2026-10-03', '05:00:00'), FATBOY)).toBe('2026-10-03');
    expect(operationalDateIn(atSec('2026-10-03', '05:00:01'), FATBOY)).toBe('2026-10-03');
  });

  it('la hora de corte viene de la política (no hay 05:00 fijas): con corte 06:00 las 05:30 aún son del día anterior', () => {
    expect(operationalDate(atSec('2026-10-03', '05:30:00'), TZ, '06:00')).toBe('2026-10-02');
    expect(operationalDate(atSec('2026-10-03', '06:00:00'), TZ, '06:00')).toBe('2026-10-03');
    expect(operationalDate(atSec('2026-10-03', '00:30:00'), TZ, '00:00')).toBe('2026-10-03'); // corte a medianoche = día de calendario
  });

  it('cambios de horario (DST): 01-nov (se repite la 01:00) y 14-mar (no existe la 02:00) respetan el corte', () => {
    expect(operationalDateIn(new Date('2026-11-01T08:30:00Z'), FATBOY)).toBe('2026-10-31'); // 01:30 PDT
    expect(operationalDateIn(new Date('2026-11-01T09:30:00Z'), FATBOY)).toBe('2026-10-31'); // 01:30 PST (repetida)
    expect(operationalDateIn(new Date('2026-11-01T12:59:59Z'), FATBOY)).toBe('2026-10-31'); // 04:59:59 PST
    expect(operationalDateIn(new Date('2026-11-01T13:00:00Z'), FATBOY)).toBe('2026-11-01'); // 05:00 PST
    expect(operationalDateIn(new Date('2027-03-14T11:59:59Z'), FATBOY)).toBe('2027-03-13'); // 04:59:59 PDT
    expect(operationalDateIn(new Date('2027-03-14T12:00:00Z'), FATBOY)).toBe('2027-03-14'); // 05:00 PDT
  });

  it('la ventana de un día operativo es exactamente el inverso de la regla [corte, siguiente corte)', () => {
    for (const date of ['2026-10-02', '2026-10-31', '2026-11-01', '2027-03-13', '2027-03-14']) {
      const { start, end } = operationalDayWindow(date, FATBOY);
      expect(operationalDateIn(start, FATBOY)).toBe(date);
      expect(operationalDateIn(new Date(start.getTime() - 1000), FATBOY)).not.toBe(date);
      expect(operationalDateIn(new Date(end.getTime() - 1000), FATBOY)).toBe(date);
      expect(operationalDateIn(end, FATBOY)).not.toBe(date);
    }
  });

  it('la gemela SQL (solo para migraciones) da exactamente lo mismo que la función canónica', async () => {
    const cases: [Date, string, string][] = [];
    for (const tz of [TZ, 'America/Mexico_City', 'UTC']) {
      for (const cutoff of ['05:00:00', '06:00:00', '00:00:00', '23:30:00']) {
        for (const iso of ['2026-10-03T07:00:00Z', '2026-10-03T11:59:59Z', '2026-10-03T12:00:00Z', '2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z', '2026-11-01T12:59:59Z', '2026-11-01T13:00:00Z', '2027-03-14T11:59:59Z', '2027-03-14T12:00:00Z', '2026-12-31T23:59:59Z']) {
          cases.push([new Date(iso), tz, cutoff]);
        }
      }
    }
    const { rows } = await pools.superuser.query(
      `SELECT core.operational_date(x.i, x.tz, x.c)::text AS d FROM unnest($1::timestamptz[], $2::text[], $3::time[]) WITH ORDINALITY AS x(i, tz, c, n) ORDER BY n`,
      [cases.map((c) => c[0].toISOString()), cases.map((c) => c[1]), cases.map((c) => c[2])],
    );
    expect(rows.map((r) => r.d)).toEqual(cases.map(([i, tz, c]) => operationalDate(i, tz, c)));
  });
});

describe('turnos, jornadas, tablero, reconciliación, solicitudes y reportes usan el MISMO día operativo', () => {
  let early: { id: string; pin: string };
  let earlyShift: { id: string; businessDate: string; operationalDate: string };
  let night: { id: string; pin: string };
  let absent: { id: string; pin: string };
  let absentShiftId: string;

  beforeAll(async () => {
    now = new Date('2026-10-01T12:00:00Z');
    early = await F.employee('Madrugada', F.VEN);
    night = await F.employee('Nocturno', F.VEN);
    absent = await F.employee('Falto', F.VEN);
    earlyShift = (await F.publishedShift(early, F.VEN, '2026-10-03', '01:30', '04:00')) as never;
    await F.publishedShift(night, F.VEN, '2026-10-02', '22:00', '06:00'); // cruza medianoche
    absentShiftId = ((await F.publishedShift(absent, F.VEN, '2026-10-03', '01:00', '04:30')) as { id: string }).id;
  });

  it('turno: la fecha de planeación es la del calendario, pero el día operativo es el anterior si empieza antes del corte', async () => {
    expect(earlyShift).toMatchObject({ businessDate: '2026-10-03', operationalDate: '2026-10-02' });
    const day = await F.publishedShift(await F.employee('Mañana', F.VEN), F.VEN, '2026-10-03', '05:00', '13:00');
    expect(day).toMatchObject({ businessDate: '2026-10-03', operationalDate: '2026-10-03' });
    const before = await F.publishedShift(await F.employee('Antes', F.VEN), F.VEN, '2026-10-03', '04:59', '12:00');
    expect(before).toMatchObject({ operationalDate: '2026-10-02' });
  });

  it('turno que cruza medianoche (22:00–06:00): todo pertenece al día en que empezó, incluida la salida de las 06:00', async () => {
    now = at('2026-10-02', '22:00');
    const r = await F.punch(F.kioskVEN, night, 'CLOCK_IN');
    now = at('2026-10-03', '06:00');
    await F.punch(F.kioskVEN, night, 'CLOCK_OUT');
    const s = (await pools.platform.query('SELECT operational_date::text AS d, started_at, ended_at FROM attendance.work_sessions WHERE id = $1', [r.workSessionId])).rows[0];
    expect(s.d).toBe('2026-10-02');
    expect(new Date(s.ended_at).toISOString()).toBe(at('2026-10-03', '06:00').toISOString()); // el instante real no se toca
  });

  it('jornada ligada a turno de madrugada y tablero "hoy": a las 02:00 del 3 el día operativo es el 2 y ahí aparece', async () => {
    now = at('2026-10-03', '01:35');
    const r = await F.punch(F.kioskVEN, early, 'CLOCK_IN');
    const s = (await pools.platform.query('SELECT operational_date::text AS d, shift_id FROM attendance.work_sessions WHERE id = $1', [r.workSessionId])).rows[0];
    expect(s).toEqual({ d: '2026-10-02', shift_id: earlyShift.id });

    now = atSec('2026-10-03', '04:59:59');
    expect((await world.attendanceQuery.today(F.ctx, F.admin, F.VEN)).today).toBe('2026-10-02'); // "hoy" de los filtros del panel
    const board = await world.attendanceQuery.board(F.ctx, F.admin, F.VEN);
    expect(board.operationalDate).toBe('2026-10-02');
    const row = board.rows.find((x) => x.employee.id === early.id)!;
    expect(row).toMatchObject({ state: 'WORKING' });
    expect(row.shift?.id).toBe(earlyShift.id);

    now = atSec('2026-10-03', '05:00:00');
    expect(await world.attendanceQuery.today(F.ctx, F.admin, F.VEN)).toEqual({ today: '2026-10-03', timezone: TZ, cutoff: '05:00' });
    const next = await world.attendanceQuery.board(F.ctx, F.admin, F.VEN);
    expect(next.operationalDate).toBe('2026-10-03');
    expect(next.counters.scheduled).toBe(next.rows.filter((x) => x.shift && x.shift.operationalDate === '2026-10-03').length); // su turno es del día 2
    const carried = next.rows.filter((x) => x.employee.id === early.id);
    expect(carried).toHaveLength(1); // solo la jornada abierta de "ayer" (RN-RT-01), con su turno del día 2
    expect(carried[0]).toMatchObject({ state: 'WORKING', session: { operationalDate: '2026-10-02' } });
  });

  it('jornada SIN turno: 04:59:59 ⇒ día anterior; 05:00:00 ⇒ día nuevo', async () => {
    const a = await F.employee('SinTurnoA', F.SMA);
    const b = await F.employee('SinTurnoB', F.SMA);
    now = atSec('2026-10-03', '04:59:59');
    const ra = await F.punch(F.kioskSMA, a, 'CLOCK_IN');
    now = atSec('2026-10-03', '05:00:00');
    const rb = await F.punch(F.kioskSMA, b, 'CLOCK_IN');
    const dates = (await pools.platform.query('SELECT id, operational_date::text AS d FROM attendance.work_sessions WHERE id = ANY($1)', [[ra.workSessionId, rb.workSessionId]])).rows;
    expect(Object.fromEntries(dates.map((r) => [r.id, r.d]))).toEqual({ [ra.workSessionId]: '2026-10-02', [rb.workSessionId]: '2026-10-03' });
  });

  it('reconciliación: la FALTA de un turno de 01:00–04:30 del día 3 queda en el día operativo 2', async () => {
    now = at('2026-10-03', '06:00');
    await world.reconciler.reconcileOrganization(F.orgId);
    const f = (await pools.platform.query(`SELECT operational_date::text AS d FROM attendance.incidents WHERE shift_id = $1 AND type = 'FALTA'`, [absentShiftId])).rows;
    expect(f).toEqual([{ d: '2026-10-02' }]);
  });

  it('solicitud sobre esa FALTA (jornada no registrada con turno): mismo día operativo; la ventana se mide con él', async () => {
    const view = await world.correctionRequests.ownRecords(F.ctx, absent.id, F.VEN);
    expect(view.absences.map((x) => x.operationalDate)).toEqual(['2026-10-02']);
    const { request } = await world.correctionRequests.create(F.ctx, { channel: 'PANEL', userId: F.ctx.actor.userId! }, absent.id, {
      clientRequestId: crypto.randomUUID(),
      action: 'CREATE_SESSION',
      shiftId: absentShiftId,
      start: { date: '2026-10-03', time: '01:05' },
      end: { date: '2026-10-03', time: '04:30' },
      reason: 'Sí vine, se cayó la red',
    });
    expect(request.operationalDate).toBe('2026-10-02');
  });

  it('reportes y exportaciones agrupan por el mismo día: el 2 incluye madrugada del 3, nocturno y la falta; "hoy" respeta el corte', async () => {
    now = at('2026-10-03', '06:00');
    const day2 = await world.reports.run(F.ctx, F.admin, { report: 'sessions', from: '2026-10-02', to: '2026-10-02', branchId: F.VEN });
    const names = day2.rows.map((r) => String(r.employee));
    expect(names.some((n) => n.startsWith('Madrugada'))).toBe(true);
    expect(names.some((n) => n.startsWith('Nocturno'))).toBe(true);
    expect(day2.rows.find((r) => String(r.employee).startsWith('Falto'))).toMatchObject({ status: 'Falta', operationalDate: '2026-10-02' });
    const day3 = await world.reports.run(F.ctx, F.admin, { report: 'sessions', from: '2026-10-03', to: '2026-10-03', branchId: F.VEN });
    expect(day3.rows.some((r) => String(r.employee).startsWith('Madrugada'))).toBe(false);
    const summary = await world.reports.run(F.ctx, F.admin, { report: 'summary', from: '2026-10-02', to: '2026-10-02', branchId: F.VEN });
    expect(summary.rows.find((r) => String(r.employee).startsWith('Madrugada'))).toMatchObject({ scheduledShifts: 1, sessions: 1 });

    const csv = toCsv(day2).toString('utf8');
    const line = csv.split('\r\n').find((l) => l.includes('Madrugada'))!;
    expect(line.startsWith('2026-10-02,')).toBe(true);
    const file = await world.reports.export(F.ctx, F.admin, { report: 'sessions', from: '2026-10-02', to: '2026-10-02', branchId: F.VEN }, 'csv');
    expect(file.body.toString('utf8')).toContain(line);

    now = atSec('2026-10-03', '04:59:59');
    expect((await world.reports.periods(F.ctx, F.admin, F.VEN)).today).toBe('2026-10-02');
    expect((await world.reports.run(F.ctx, F.admin, { report: 'sessions', period: 'today', branchId: F.VEN })).from).toBe('2026-10-02');
    now = atSec('2026-10-03', '05:00:00');
    expect((await world.reports.periods(F.ctx, F.admin, F.VEN)).today).toBe('2026-10-03');
  });
});

describe('PostgreSQL impide que turno, jornada, falta y solicitud diverjan', () => {
  it('jornada ligada con otro día operativo ⇒ SESSION_DATE_MISMATCH; FALTA con otro día ⇒ INCIDENT_DATE_MISMATCH', async () => {
    const p = await F.employee('Guarda', F.VEN);
    now = new Date('2026-10-01T12:00:00Z');
    const s = (await F.publishedShift(p, F.VEN, '2026-10-10', '02:00', '04:00')) as { id: string; operationalDate: string };
    expect(s.operationalDate).toBe('2026-10-09');
    const c = await pools.superuser.connect();
    try {
      await c.query('BEGIN');
      const session = await pgError(c, `INSERT INTO attendance.work_sessions (organization_id, branch_id, employee_id, shift_id, operational_date, started_at, status, origin, policy_snapshot)
        VALUES ($1, $2, $3, $4, '2026-10-10', $5, 'OPEN', 'KIOSK', '{}')`, [F.orgId, F.VEN, p.id, s.id, at('2026-10-10', '02:00')]);
      expect(session?.message).toBe('SESSION_DATE_MISMATCH');
      const falta = await pgError(c, `INSERT INTO attendance.incidents (organization_id, branch_id, employee_id, shift_id, operational_date, type, status, details, detected_at, detected_by)
        VALUES ($1, $2, $3, $4, '2026-10-10', 'FALTA', 'OPEN', '{}', now(), 'RECONCILER')`, [F.orgId, F.VEN, p.id, s.id]);
      expect(falta?.message).toBe('INCIDENT_DATE_MISMATCH');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('un turno con jornada no cambia de día operativo (SHIFT_HAS_ATTENDANCE); sin jornada sí, y su FALTA se anula', async () => {
    const p = await F.employee('Movido', F.VEN);
    now = new Date('2026-10-01T12:00:00Z');
    const s = (await F.publishedShift(p, F.VEN, '2026-10-12', '03:00', '07:00')) as { id: string; version: number };
    now = at('2026-10-12', '03:00');
    await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    const v = (await pools.platform.query('SELECT version FROM scheduling.shifts WHERE id = $1', [s.id])).rows[0].version;
    await expect(world.scheduling.updateShift(F.ctx, F.admin, s.id, v, { startTime: '05:30', endTime: '09:00' }, 'Ajuste')).rejects.toMatchObject({ code: 'SHIFT_HAS_ATTENDANCE' });
    // mismo día operativo: sí se permite (no cambia la agrupación)
    await world.scheduling.updateShift(F.ctx, F.admin, s.id, v, { startTime: '02:30', endTime: '07:00' }, 'Ajuste');

    const q = await F.employee('MovidoFalta', F.VEN);
    now = new Date('2026-10-01T12:00:00Z');
    const t = (await F.publishedShift(q, F.VEN, '2026-10-14', '01:00', '03:00')) as { id: string };
    now = at('2026-10-14', '04:00');
    await world.reconciler.reconcileOrganization(F.orgId);
    const tv = (await pools.platform.query('SELECT version FROM scheduling.shifts WHERE id = $1', [t.id])).rows[0].version;
    const moved = await world.scheduling.updateShift(F.ctx, F.admin, t.id, tv, { startTime: '00:30', endTime: '01:45', date: '2026-10-13' }, 'Era del día anterior');
    expect(moved).toMatchObject({ operationalDate: '2026-10-12' });
    await world.reconciler.reconcileOrganization(F.orgId);
    const rows = (await pools.platform.query(`SELECT operational_date::text AS d, resolution FROM attendance.incidents WHERE shift_id = $1 AND type = 'FALTA' ORDER BY created_at`, [t.id])).rows;
    expect(rows).toEqual([
      { d: '2026-10-13', resolution: 'VOIDED' },
      { d: '2026-10-12', resolution: null },
    ]);
  });

  it('cambiar la hora de corte recalcula los turnos que aún no empiezan (hacia adelante); lo ocurrido conserva su día', async () => {
    const p = await F.employee('Corte', F.SMA);
    now = new Date('2026-10-01T12:00:00Z');
    const future = (await F.publishedShift(p, F.SMA, '2026-10-20', '05:30', '09:00')) as { id: string; operationalDate: string };
    expect(future.operationalDate).toBe('2026-10-20');
    await world.policies.setOverride(F.ctx, 'BRANCH', F.SMA, { operationalCutoff: '06:00' });
    const d = async (id: string) => (await pools.platform.query('SELECT operational_date::text AS d FROM scheduling.shifts WHERE id = $1', [id])).rows[0].d;
    expect(await d(future.id)).toBe('2026-10-19');
    // el reloj marca 05:00 en Tijuana: con corte 06:00 todavía es el día operativo 30-sep (con 05:00 ya sería 1-oct)
    expect((await world.reports.periods(F.ctx, F.admin, F.SMA)).today).toBe('2026-09-30');
    expect((await world.reports.periods(F.ctx, F.admin, F.VEN)).today).toBe('2026-10-01');
    await world.policies.setOverride(F.ctx, 'BRANCH', F.SMA, { operationalCutoff: null });
    expect(await d(future.id)).toBe('2026-10-20');
  });
});

describe('arquitectura: una sola definición del día operativo', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  const src = path.resolve(__dirname, '../src');

  it('solo common/operational-day.ts compara la hora local contra la hora de corte', () => {
    const definers = files(src).filter((f) => /export function operationalDate\b/.test(readFileSync(f, 'utf8')));
    expect(definers.map((f) => path.relative(src, f))).toEqual(['common/operational-day.ts']);
  });

  it('asistencia y reportes nunca agrupan por la fecha de planeación del turno (`businessDate`)', () => {
    const offenders = files(path.join(src, 'modules/attendance'))
      .concat(files(path.join(src, 'modules/reports')))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ f: path.relative(src, f), i: i + 1, line }))
          .filter((x) => x.line.includes('businessDate') && !/^\s*businessDate: shift\.businessDate,$/.test(x.line)),
      );
    expect(offenders).toEqual([]);
  });
});

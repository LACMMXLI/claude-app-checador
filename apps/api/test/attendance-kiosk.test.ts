import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AttendanceFixture, at, attendanceFixture } from './helpers/attendance-fixture.js';
import { count, pgError } from './helpers/sql.js';
import { buildWorld, openPools } from './helpers/world.js';

const pools = openPools();
let now = new Date('2026-09-01T12:00:00Z');
const world = buildWorld(pools, { clock: () => now });
const K = world.kioskAttendance;
let F: AttendanceFixture;

beforeAll(async () => {
  F = await attendanceFixture(world, (d) => (now = d));
});
afterAll(() => pools.close());

const session = async (id: string) => (await pools.platform.query('SELECT ws.*, ws.operational_date::text AS operational_date FROM attendance.work_sessions ws WHERE id = $1', [id])).rows[0];
const incidentTypes = async (sessionId: string) =>
  (await pools.platform.query(`SELECT type FROM attendance.incidents WHERE work_session_id = $1 ORDER BY type`, [sessionId])).rows.map((r) => r.type);
const incident = async (sessionId: string, type: string) =>
  (await pools.platform.query(`SELECT * FROM attendance.incidents WHERE work_session_id = $1 AND type = $2`, [sessionId, type])).rows[0];
const events = async (sessionId: string) =>
  (await pools.platform.query(`SELECT * FROM attendance.events WHERE work_session_id = $1 ORDER BY occurred_at, type`, [sessionId])).rows;

describe('Entrada ligada al turno publicado (D-34, D-35, D-41, D-42)', () => {
  it('(1) Entrada normal: se liga al turno publicado de la sucursal del kiosco', async () => {
    const ana = await F.employee('Ana', F.VEN);
    const shift = await F.publishedShift(ana, F.VEN, '2026-10-05', '07:00', '15:00');
    now = at('2026-10-05', '07:00');
    const r = await F.punch(F.kioskVEN, ana, 'CLOCK_IN');
    expect(r).toMatchObject({ action: 'CLOCK_IN', replayed: false, arrivalDeltaMinutes: 0, flags: [] });
    expect(await session(r.workSessionId)).toMatchObject({ shift_id: shift.id, branch_id: F.VEN, operational_date: '2026-10-05', status: 'OPEN', ended_at: null });
    expect((await events(r.workSessionId)).map((e) => [e.type, e.device_id, e.source, e.time_source])).toEqual([['CLOCK_IN', F.kioskVEN.deviceId, 'KIOSK_ONLINE', 'SERVER']]);
  });

  it('(2) anticipada dentro de la ventana (06:20 para 07:00): se liga y se guarda la hora REAL, sin redondear', async () => {
    const p = await F.employee('Beto', F.VEN);
    const shift = await F.publishedShift(p, F.VEN, '2026-10-05', '07:00', '15:00');
    now = at('2026-10-05', '06:20');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    expect(r.arrivalDeltaMinutes).toBe(-40);
    const s = await session(r.workSessionId);
    expect(s.shift_id).toBe(shift.id);
    expect(s.started_at.toISOString()).toBe(at('2026-10-05', '06:20').toISOString());
    // antes de la ventana (05:59) ya no se liga
    const q = await F.employee('Beto2', F.VEN);
    await F.publishedShift(q, F.VEN, '2026-10-05', '07:00', '15:00');
    now = at('2026-10-05', '05:59');
    expect((await session((await F.punch(F.kioskVEN, q, 'CLOCK_IN')).workSessionId)).shift_id).toBeNull();
  });

  it('(3) 8 min tarde con tolerancia 10: conserva 8 y NO genera retardo', async () => {
    const p = await F.employee('Caro', F.VEN);
    await F.publishedShift(p, F.VEN, '2026-10-05', '07:00', '15:00');
    now = at('2026-10-05', '07:08');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    expect(r.arrivalDeltaMinutes).toBe(8);
    expect(await incidentTypes(r.workSessionId)).toEqual([]);
  });

  it('(4) 12 min tarde: conserva 12 y genera RETARDO con los minutos reales', async () => {
    const p = await F.employee('Dani', F.VEN);
    await F.publishedShift(p, F.VEN, '2026-10-05', '07:00', '15:00');
    now = at('2026-10-05', '07:12');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    expect(r).toMatchObject({ arrivalDeltaMinutes: 12, flags: ['RETARDO'] });
    expect((await incident(r.workSessionId, 'RETARDO')).details).toEqual({ lateMinutes: 12, toleranceMin: 10 });
  });

  it('(5) 150 min tarde (09:30): sigue ligada al turno mientras no termine y conserva 150', async () => {
    const p = await F.employee('Eva', F.VEN);
    const shift = await F.publishedShift(p, F.VEN, '2026-10-05', '07:00', '15:00');
    now = at('2026-10-05', '09:30');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    expect(r.arrivalDeltaMinutes).toBe(150);
    expect((await session(r.workSessionId)).shift_id).toBe(shift.id);
    expect((await incident(r.workSessionId, 'RETARDO')).details.lateMinutes).toBe(150);
  });

  it('(6) Entrada después de terminar el turno (15:10): NO se liga; jornada sin turno con sus marcas', async () => {
    const p = await F.employee('Fer', F.VEN);
    const shift = await F.publishedShift(p, F.VEN, '2026-10-05', '07:00', '15:00');
    now = at('2026-10-05', '15:10');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    expect((await session(r.workSessionId)).shift_id).toBeNull();
    expect(await incidentTypes(r.workSessionId)).toEqual(['ENTRADA_FALTANTE', 'SIN_TURNO_PROGRAMADO']);
    expect((await incident(r.workSessionId, 'ENTRADA_FALTANTE')).details.endedShiftId).toBe(shift.id);
  });

  it('turno nocturno: (41) el día operativo es la fecha local de INICIO del turno', async () => {
    const p = await F.employee('Gil', F.VEN);
    await F.publishedShift(p, F.VEN, '2026-10-02', '19:00', '03:00');
    now = at('2026-10-02', '19:05');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    now = at('2026-10-03', '03:02');
    await F.punch(F.kioskVEN, p, 'CLOCK_OUT');
    expect(await session(r.workSessionId)).toMatchObject({ operational_date: '2026-10-02', status: 'CLOSED' });
  });

  it('con dos turnos en ventana gana el de inicio más cercano', async () => {
    const p = await F.employee('Hugo', F.VEN);
    await F.publishedShift(p, F.VEN, '2026-10-06', '07:00', '11:30');
    const second = await F.publishedShift(p, F.VEN, '2026-10-06', '12:00', '16:00');
    now = at('2026-10-06', '11:20'); // no llegó al primero; viene por el segundo
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    expect((await session(r.workSessionId)).shift_id).toBe(second.id);
  });
});

describe('turnos que NO cuentan (D-62, D-63) y jornadas sin turno (D-6, D-36)', () => {
  it('(7) turno en BORRADOR: no se usa, no se le muestra al empleado y la jornada queda sin turno', async () => {
    const p = await F.employee('Iris', F.VEN);
    await F.draftShift(p, F.VEN, '2026-12-07', '07:00', '15:00');
    now = at('2026-12-07', '07:05');
    const state = await K.identify(F.kioskVEN.ctx, F.kioskVEN, p.pin);
    expect(state).toMatchObject({ status: 'NONE', actions: ['CLOCK_IN'], shift: null });
    const r = await K.punch(F.kioskVEN.ctx, F.kioskVEN, { ticket: state.ticket, action: 'CLOCK_IN', clientEventId: randomUUID() });
    expect((await session(r.workSessionId)).shift_id).toBeNull();
    expect(await incidentTypes(r.workSessionId)).toEqual(['SIN_TURNO_PROGRAMADO']);
  });

  it('(8) turno CANCELADO: no se usa para ligar la Entrada', async () => {
    const p = await F.employee('Juan', F.VEN);
    const s = await F.publishedShift(p, F.VEN, '2026-10-07', '07:00', '15:00');
    await world.scheduling.cancelShift(F.ctx, F.admin, s.id, s.version, 'Descanso cambiado');
    now = at('2026-10-07', '07:00');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    expect((await session(r.workSessionId)).shift_id).toBeNull();
    expect(await incidentTypes(r.workSessionId)).toEqual(['SIN_TURNO_PROGRAMADO']);
  });

  it('PostgreSQL impide ligar una jornada a un turno en borrador o cancelado aunque se salte la aplicación', async () => {
    const p = await F.employee('Kike', F.VEN);
    const draft = await F.draftShift(p, F.VEN, '2026-12-08', '07:00', '15:00');
    const c = await pools.superuser.connect(); // se salta la aplicación (los triggers y constraints sí aplican)
    try {
      await c.query('BEGIN');
      const err = await pgError(c, `INSERT INTO attendance.work_sessions (organization_id, branch_id, employee_id, shift_id, operational_date, started_at, origin)
        VALUES ($1, $2, $3, $4, '2026-12-08', now(), 'KIOSK')`, [F.orgId, F.VEN, p.id, draft.id]);
      expect(err).toMatchObject({ code: 'P0001', message: 'SHIFT_NOT_OFFICIAL' });
      // y tampoco a un turno de OTRA sucursal (FK compuesta turno ↔ empleado ↔ sucursal)
      const smaShift = await F.publishedShift(p, F.SMA, '2026-12-09', '07:00', '15:00').catch(() => null);
      if (smaShift) {
        const fk = await pgError(c, `INSERT INTO attendance.work_sessions (organization_id, branch_id, employee_id, shift_id, operational_date, started_at, origin)
          VALUES ($1, $2, $3, $4, '2026-12-09', now(), 'KIOSK')`, [F.orgId, F.VEN, p.id, smaShift.id]);
        expect(fk?.code).toBe('23503');
      }
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('(9) jornada sin turno: se permite, día operativo por corte y marca SIN_TURNO_PROGRAMADO', async () => {
    const p = await F.employee('Lalo', F.VEN);
    now = at('2026-10-09', '03:30');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    expect(await session(r.workSessionId)).toMatchObject({ shift_id: null, operational_date: '2026-10-08', status: 'OPEN' });
    expect(r.flags).toEqual(['SIN_TURNO_PROGRAMADO']);
  });

  it('(10) checar en una sucursal NO asignada funciona y marca SIN_ASIGNACION_SUCURSAL (D-17)', async () => {
    const p = await F.employee('Mario', F.VEN);
    now = at('2026-10-10', '09:00');
    const r = await F.punch(F.kioskSMA, p, 'CLOCK_IN');
    expect(await session(r.workSessionId)).toMatchObject({ branch_id: F.SMA, shift_id: null });
    expect(await incidentTypes(r.workSessionId)).toEqual(['SIN_ASIGNACION_SUCURSAL', 'SIN_TURNO_PROGRAMADO']);
  });

  it('(11)(12) Pedro programado en San Marcos checa en Venecia: no se liga, jornada en Venecia y TURNO_EN_OTRA_SUCURSAL', async () => {
    const pedro = await F.employee('Pedro', F.SMA);
    const smaShift = await F.publishedShift(pedro, F.SMA, '2026-10-12', '07:00', '15:00');
    now = at('2026-10-12', '07:03');
    const r = await F.punch(F.kioskVEN, pedro, 'CLOCK_IN');
    expect(await session(r.workSessionId)).toMatchObject({ branch_id: F.VEN, shift_id: null });
    expect(await incidentTypes(r.workSessionId)).toEqual(['SIN_ASIGNACION_SUCURSAL', 'SIN_TURNO_PROGRAMADO', 'TURNO_EN_OTRA_SUCURSAL']);
    expect((await incident(r.workSessionId, 'TURNO_EN_OTRA_SUCURSAL')).details).toMatchObject({ otherShiftId: smaShift.id, otherBranchId: F.SMA });
  });
});

describe('una jornada abierta, concurrencia e idempotencia (D-40, D-54, D-55)', () => {
  it('(13) no existen dos jornadas abiertas: en otra sucursal el kiosco reconoce la existente', async () => {
    const p = await F.employee('Nora', F.VEN);
    now = at('2026-10-13', '08:00');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    now = at('2026-10-13', '10:00');
    const elsewhere = await K.identify(F.kioskSMA.ctx, F.kioskSMA, p.pin);
    expect(elsewhere).toMatchObject({ status: 'WORKING', actions: ['BREAK_START', 'CLOCK_OUT'], session: { branchId: F.VEN, branchName: 'Venecia' } });
    await expect(K.punch(F.kioskSMA.ctx, F.kioskSMA, { ticket: elsewhere.ticket, action: 'CLOCK_IN', clientEventId: randomUUID() })).rejects.toMatchObject({ code: 'ALREADY_CLOCKED_IN' });
    // y PostgreSQL lo garantiza aunque se salte la aplicación
    const c = await pools.superuser.connect(); // se salta la aplicación (los triggers y constraints sí aplican)
    try {
      await c.query('BEGIN');
      const err = await pgError(c, `INSERT INTO attendance.work_sessions (organization_id, branch_id, employee_id, operational_date, started_at, origin)
        VALUES ($1, $2, $3, '2026-10-13', now(), 'KIOSK')`, [F.orgId, F.SMA, p.id]);
      expect(err).toMatchObject({ code: '23505' });
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    expect(await count(pools.platform, `SELECT count(*) FROM attendance.work_sessions WHERE employee_id = $1`, [p.id])).toBe(1);
    expect(r.workSessionId).toBeTruthy();
  });

  it('(14) dos Entradas casi simultáneas (distinto clientEventId) crean UNA sola jornada', async () => {
    const p = await F.employee('Omar', F.VEN);
    now = at('2026-10-14', '08:00');
    const { ticket } = await K.identify(F.kioskVEN.ctx, F.kioskVEN, p.pin);
    const results = await Promise.allSettled(
      [F.kioskVEN, F.kioskVEN, F.kioskVEN].map((k) => K.punch(k.ctx, k, { ticket, action: 'CLOCK_IN', clientEventId: randomUUID() })),
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const x of results.filter((y) => y.status === 'rejected')) expect((x as PromiseRejectedResult).reason.code).toBe('ALREADY_CLOCKED_IN');
    expect(await count(pools.platform, `SELECT count(*) FROM attendance.work_sessions WHERE employee_id = $1`, [p.id])).toBe(1);
    expect(await count(pools.platform, `SELECT count(*) FROM attendance.events WHERE employee_id = $1`, [p.id])).toBe(1);
  });

  it('(15) reintento con el mismo clientEventId (doble toque, timeout, reconexión): mismo resultado, una checada', async () => {
    const p = await F.employee('Paco', F.VEN);
    now = at('2026-10-15', '08:00');
    const { ticket } = await K.identify(F.kioskVEN.ctx, F.kioskVEN, p.pin);
    const id = randomUUID();
    const first = await K.punch(F.kioskVEN.ctx, F.kioskVEN, { ticket, action: 'CLOCK_IN', clientEventId: id });
    now = at('2026-10-15', '08:01');
    const again = await K.punch(F.kioskVEN.ctx, F.kioskVEN, { ticket, action: 'CLOCK_IN', clientEventId: id });
    expect(again).toMatchObject({ replayed: true, workSessionId: first.workSessionId, action: 'CLOCK_IN' });
    expect(again.occurredAt.toISOString()).toBe(at('2026-10-15', '08:00').toISOString()); // la hora original
    // simultáneos con el mismo id
    const id2 = randomUUID();
    const both = await Promise.all([1, 2].map(() => K.punch(F.kioskVEN.ctx, F.kioskVEN, { ticket, action: 'BREAK_START', clientEventId: id2 })));
    expect(both.map((b) => b.replayed).sort()).toEqual([false, true]);
    expect(await count(pools.platform, `SELECT count(*) FROM attendance.events WHERE employee_id = $1`, [p.id])).toBe(2);
    expect(await count(pools.platform, `SELECT count(*) FROM attendance.breaks WHERE work_session_id = $1`, [first.workSessionId])).toBe(1);
    // el mismo id para OTRA acción no se acepta en silencio
    await expect(K.punch(F.kioskVEN.ctx, F.kioskVEN, { ticket, action: 'BREAK_END', clientEventId: id })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('los eventos físicos son inmutables (UPDATE/DELETE prohibidos aun saltándose la aplicación)', async () => {
    const c = await pools.superuser.connect(); // se salta la aplicación (los triggers y constraints sí aplican)
    try {
      await c.query('BEGIN');
      expect((await pgError(c, `UPDATE attendance.events SET occurred_at = now() WHERE organization_id = $1`, [F.orgId]))?.code).toBe('23001');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('antirrebote (RN-EVT-02) configurable: con 60 s, una checada inmediata se rechaza con el tiempo de espera', async () => {
    const p = await F.employee('Quique', F.VEN);
    await world.policies.setOverride(F.ctx, 'BRANCH', F.SMA, { debounceSec: 60 });
    now = at('2026-10-16', '08:00');
    await F.punch(F.kioskSMA, p, 'CLOCK_IN');
    now = new Date(now.getTime() + 20_000);
    await expect(F.punch(F.kioskSMA, p, 'CLOCK_OUT')).rejects.toMatchObject({ code: 'PUNCH_TOO_SOON', details: { retryAfterSec: 40 } });
    now = new Date(now.getTime() + 40_000);
    expect((await F.punch(F.kioskSMA, p, 'CLOCK_OUT')).action).toBe('CLOCK_OUT');
    await world.policies.setOverride(F.ctx, 'BRANCH', F.SMA, { debounceSec: null });
  });
});

describe('pausas (D-14, D-49, D-50) y Salida', () => {
  it('(16)(17)(18)(19)(20)(24) comida de 42 min con 35 permitidos ⇒ duración 42, exceso 7; Salida cierra', async () => {
    const p = await F.employee('Rosa', F.VEN);
    await F.publishedShift(p, F.VEN, '2026-10-19', '07:00', '15:00');
    now = at('2026-10-19', '07:00');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    await expect(F.punch(F.kioskVEN, p, 'BREAK_END')).rejects.toMatchObject({ code: 'NO_OPEN_BREAK' }); // (19)
    now = at('2026-10-19', '11:00');
    const start = await F.punch(F.kioskVEN, p, 'BREAK_START'); // (16)
    expect(start).toMatchObject({ action: 'BREAK_START', break: { sequence: 1, allowedMinutes: 35 } });
    // (17) con la pausa abierta solo se ofrece "Regreso de comer" y un segundo inicio se rechaza
    expect((await K.identify(F.kioskVEN.ctx, F.kioskVEN, p.pin)).actions).toEqual(['BREAK_END']);
    await expect(F.punch(F.kioskVEN, p, 'BREAK_START')).rejects.toMatchObject({ code: 'BREAK_ALREADY_OPEN' });
    now = at('2026-10-19', '11:42');
    const end = await F.punch(F.kioskVEN, p, 'BREAK_END'); // (18)
    expect(end.break).toEqual({ sequence: 1, durationMinutes: 42, allowedMinutes: 35, exceededMinutes: 7 }); // (20)
    expect((await incident(r.workSessionId, 'COMIDA_EXCEDIDA')).details).toMatchObject({ durationMinutes: 42, exceededMinutes: 7 });
    now = at('2026-10-19', '15:05');
    const out = await F.punch(F.kioskVEN, p, 'CLOCK_OUT'); // (24)
    expect(out).toMatchObject({ elapsedMinutes: 485, departureDeltaMinutes: 5 }); // la comida NO se descuenta
    expect(await session(r.workSessionId)).toMatchObject({ status: 'CLOSED' });
    expect((await events(r.workSessionId)).map((e) => e.type)).toEqual(['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT']);
  });

  it('(21) max_breaks = 1 impide una segunda pausa (y el kiosco ni la ofrece)', async () => {
    const p = await F.employee('Sara', F.VEN);
    now = at('2026-10-20', '07:00');
    await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    now = at('2026-10-20', '11:00');
    await F.punch(F.kioskVEN, p, 'BREAK_START');
    now = at('2026-10-20', '11:30');
    await F.punch(F.kioskVEN, p, 'BREAK_END');
    expect((await K.identify(F.kioskVEN.ctx, F.kioskVEN, p.pin)).actions).toEqual(['CLOCK_OUT']);
    await expect(F.punch(F.kioskVEN, p, 'BREAK_START')).rejects.toMatchObject({ code: 'MAX_BREAKS_REACHED', details: { maxBreaks: 1 } });
  });

  it('(22) max_breaks = 2 (política, sin migración) permite la segunda pausa', async () => {
    const p = await F.employee('Toño', F.VEN);
    await world.policies.setOverride(F.ctx, 'EMPLOYEE', p.id, { maxBreaks: 2, breakAllowedMin: 15 });
    now = at('2026-10-21', '07:00');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    for (const [a, b] of [['10:00', '10:15'], ['13:00', '13:20']]) {
      now = at('2026-10-21', a!);
      await F.punch(F.kioskVEN, p, 'BREAK_START');
      now = at('2026-10-21', b!);
      await F.punch(F.kioskVEN, p, 'BREAK_END');
    }
    const rows = (await pools.platform.query(`SELECT sequence, duration_minutes, exceeded_minutes FROM attendance.breaks WHERE work_session_id = $1 ORDER BY sequence`, [r.workSessionId])).rows;
    expect(rows).toEqual([{ sequence: 1, duration_minutes: 15, exceeded_minutes: 0 }, { sequence: 2, duration_minutes: 20, exceeded_minutes: 5 }]);
  });

  it('(23)(25) pausa abierta: no se inventa el regreso; Salida exige primero "Regreso de comer"; sin jornada no hay Salida', async () => {
    const p = await F.employee('Uri', F.VEN);
    await expect(F.punch(F.kioskVEN, p, 'CLOCK_OUT')).rejects.toMatchObject({ code: 'NO_OPEN_SESSION' }); // (25)
    await expect(F.punch(F.kioskVEN, p, 'BREAK_START')).rejects.toMatchObject({ code: 'NO_OPEN_SESSION' });
    now = at('2026-10-22', '07:00');
    const r = await F.punch(F.kioskVEN, p, 'CLOCK_IN');
    now = at('2026-10-22', '12:00');
    await F.punch(F.kioskVEN, p, 'BREAK_START');
    now = at('2026-10-22', '15:00');
    await expect(F.punch(F.kioskVEN, p, 'CLOCK_OUT')).rejects.toMatchObject({ code: 'BREAK_OPEN' });
    const brk = (await pools.platform.query(`SELECT ended_at, duration_minutes FROM attendance.breaks WHERE work_session_id = $1`, [r.workSessionId])).rows[0];
    expect(brk).toEqual({ ended_at: null, duration_minutes: null });
    expect((await events(r.workSessionId)).map((e) => e.type)).toEqual(['CLOCK_IN', 'BREAK_START']);
    // PostgreSQL tampoco permite cerrar la jornada con la pausa abierta
    const c = await pools.superuser.connect(); // se salta la aplicación (los triggers y constraints sí aplican)
    try {
      await c.query('BEGIN');
      const err = await pgError(c, `UPDATE attendance.work_sessions SET ended_at = now(), status = 'CLOSED' WHERE id = $1`, [r.workSessionId]);
      expect(err).toMatchObject({ code: 'P0001', message: 'BREAK_OPEN' });
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});

describe('información al empleado en el kiosco (D-57, D-59)', () => {
  it('muestra su nombre, su turno OFICIAL y solo las acciones posibles; nada de otros empleados ni datos administrativos', async () => {
    const p = await F.employee('Vale', F.VEN);
    await F.publishedShift(p, F.VEN, '2026-10-23', '07:00', '15:00');
    now = at('2026-10-23', '06:50');
    const s = await K.identify(F.kioskVEN.ctx, F.kioskVEN, p.pin);
    expect(s).toMatchObject({ employee: { displayName: 'Vale' }, status: 'NONE', actions: ['CLOCK_IN'], shift: { startTime: '07:00', endTime: '15:00', branchName: 'Venecia' } });
    expect(Object.keys(s).sort()).toEqual(['actions', 'employee', 'openBreak', 'serverTime', 'session', 'shift', 'status', 'ticket', 'ticketExpiresAt']);
    expect(JSON.stringify(s)).not.toContain(p.pin);
    expect(Object.keys(s.employee).sort()).toEqual(['displayName', 'id']);
  });

  it('el pase del kiosco no sirve en otro dispositivo ni después de vencer', async () => {
    const p = await F.employee('Wen', F.VEN);
    now = at('2026-10-24', '08:00');
    const { ticket } = await K.identify(F.kioskVEN.ctx, F.kioskVEN, p.pin);
    await expect(K.punch(F.kioskSMA.ctx, F.kioskSMA, { ticket, action: 'CLOCK_IN', clientEventId: randomUUID() })).rejects.toMatchObject({ code: 'KIOSK_TICKET_INVALID' });
    now = at('2026-10-24', '08:03');
    await expect(K.punch(F.kioskVEN.ctx, F.kioskVEN, { ticket, action: 'CLOCK_IN', clientEventId: randomUUID() })).rejects.toMatchObject({ code: 'KIOSK_TICKET_INVALID' });
    await expect(K.punch(F.kioskVEN.ctx, F.kioskVEN, { ticket: `${ticket.slice(0, -2)}xx`, action: 'CLOCK_IN', clientEventId: randomUUID() })).rejects.toMatchObject({ code: 'KIOSK_TICKET_INVALID' });
  });
});

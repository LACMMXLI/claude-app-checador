import { describe, expect, it } from 'vitest';
import {
  firstCutoffAfter,
  isLate,
  minutesBetween,
  operationalDate,
  pendingArrivalState,
  sessionMetrics,
} from '../src/modules/attendance/attendance-time.js';
import { at, TZ } from './helpers/attendance-fixture.js';

const policy = { entryToleranceMin: 10, absentAfterMin: 60 };

describe('día operativo (D-46) — función pura', () => {
  it('(42) sin turno a las 03:30 con corte 05:00 pertenece al día anterior', () => {
    expect(operationalDate(at('2026-10-03', '03:30'), TZ, '05:00:00')).toBe('2026-10-02');
  });

  it('(43) sin turno a las 05:15 pertenece al día actual; exactamente 05:00 ya es el día nuevo', () => {
    expect(operationalDate(at('2026-10-03', '05:15'), TZ, '05:00:00')).toBe('2026-10-03');
    expect(operationalDate(at('2026-10-03', '05:00'), TZ, '05:00')).toBe('2026-10-03');
    expect(operationalDate(at('2026-10-03', '04:59'), TZ, '05:00')).toBe('2026-10-02');
  });

  it('usa la zona IANA efectiva, no un offset fijo (mismo instante, otra zona ⇒ otro día operativo)', () => {
    const instant = new Date('2026-10-03T10:30:00Z'); // 03:30 en Tijuana, 04:30 en CDMX, 10:30 en UTC
    expect(operationalDate(instant, 'America/Tijuana', '05:00')).toBe('2026-10-02');
    expect(operationalDate(instant, 'America/Mexico_City', '05:00')).toBe('2026-10-02');
    expect(operationalDate(instant, 'UTC', '05:00')).toBe('2026-10-03');
    // en invierno Tijuana es UTC−8: el mismo reloj UTC cae una hora antes
    expect(operationalDate(new Date('2026-12-03T12:30:00Z'), 'America/Tijuana', '05:00')).toBe('2026-12-02');
    expect(operationalDate(new Date('2026-12-03T13:30:00Z'), 'America/Tijuana', '05:00')).toBe('2026-12-03');
  });
});

describe('corte operativo para jornadas abiertas (D-47)', () => {
  it('turno 19:00–03:00 con corte 05:00: la revisión llega a las 05:00 del día siguiente', () => {
    expect(firstCutoffAfter(at('2026-10-03', '03:00'), TZ, '05:00').toISOString()).toBe(at('2026-10-03', '05:00').toISOString());
  });
  it('turno 07:00–15:00: el primer corte POSTERIOR al fin es el del día siguiente', () => {
    expect(firstCutoffAfter(at('2026-10-02', '15:00'), TZ, '05:00').toISOString()).toBe(at('2026-10-03', '05:00').toISOString());
  });
  it('un turno que termina justo a la hora de corte se revisa en el corte siguiente (estrictamente posterior)', () => {
    expect(firstCutoffAfter(at('2026-10-03', '05:00'), TZ, '05:00').toISOString()).toBe(at('2026-10-04', '05:00').toISOString());
  });
  it('si la hora de corte no existe por DST se usa el primer minuto válido posterior', () => {
    // 14-mar-2027 02:00 → 03:00 en Tijuana: un corte a las 02:30 no existe ese día
    expect(firstCutoffAfter(at('2027-03-14', '01:00'), TZ, '02:30').toISOString()).toBe(at('2027-03-14', '03:00').toISOString());
  });
});

describe('estados de llegada derivados (D-43) y retardo real (D-41)', () => {
  const shift = { startsAt: at('2026-10-05', '07:00'), endsAt: at('2026-10-05', '15:00') };
  it.each([
    ['06:59', 'UPCOMING'],
    ['07:00', 'WITHIN_TOLERANCE'],
    ['07:10', 'WITHIN_TOLERANCE'],
    ['07:11', 'LATE_NOT_ARRIVED'],
    ['07:59', 'LATE_NOT_ARRIVED'],
    ['08:00', 'ABSENT_NOT_ARRIVED'],
    ['14:59', 'ABSENT_NOT_ARRIVED'],
    ['15:00', 'MISSED'],
  ])('%s ⇒ %s', (time, state) => {
    expect(pendingArrivalState(shift, at('2026-10-05', time), policy)).toBe(state);
  });

  it('la tolerancia solo decide la incidencia: 8 min no es retardo; 12 sí; los minutos reales se conservan', () => {
    expect(minutesBetween(shift.startsAt, at('2026-10-05', '07:08'))).toBe(8);
    expect(isLate(8, 10)).toBe(false);
    expect(minutesBetween(shift.startsAt, at('2026-10-05', '07:12'))).toBe(12);
    expect(isLate(12, 10)).toBe(true);
    expect(minutesBetween(shift.startsAt, at('2026-10-05', '06:40'))).toBe(-20);
  });

  it('los segundos se truncan antes de comparar (RN §9)', () => {
    expect(minutesBetween(new Date('2026-10-05T14:00:59Z'), new Date('2026-10-05T14:08:00Z'))).toBe(8);
    expect(minutesBetween(new Date('2026-10-05T14:00:00Z'), new Date('2026-10-05T14:10:59Z'))).toBe(10);
  });
});

describe('duración real (D-64) y diferencias contra el turno (D-65)', () => {
  it('(44) DST: una jornada nocturna del cambio de horario dura sus horas REALES', () => {
    // 31-oct 22:00 PDT → 1-nov 06:00 PST: en el reloj de pared son 8 h, en realidad 9 h
    const m = sessionMetrics({ startedAt: at('2026-10-31', '22:00'), endedAt: at('2026-11-01', '06:00') }, null, [], new Date());
    expect(m.elapsedMinutes).toBe(540);
  });

  it('salida anticipada y tardía con signo; pausas aparte y sin descontarse; sin salida no hay duración', () => {
    const shift = { startsAt: at('2026-10-05', '07:00'), endsAt: at('2026-10-05', '15:00') };
    const breaks = [{ startedAt: at('2026-10-05', '11:00'), endedAt: at('2026-10-05', '11:42'), durationMinutes: 42, exceededMinutes: 7 }];
    const early = sessionMetrics({ startedAt: at('2026-10-05', '07:00'), endedAt: at('2026-10-05', '14:40') }, shift, breaks, new Date());
    expect(early).toMatchObject({ departureDeltaMinutes: -20, elapsedMinutes: 460, breakMinutes: 42, breakExcessMinutes: 7, scheduledMinutes: 480 });
    const late = sessionMetrics({ startedAt: at('2026-10-05', '07:00'), endedAt: at('2026-10-05', '15:12') }, shift, [], new Date());
    expect(late.departureDeltaMinutes).toBe(12);
    const open = sessionMetrics({ startedAt: at('2026-10-05', '07:00'), endedAt: null }, shift, [], at('2026-10-05', '09:00'));
    expect(open).toMatchObject({ elapsedMinutes: null, departureDeltaMinutes: null, runningMinutes: 120 });
  });
});

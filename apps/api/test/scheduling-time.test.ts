import { describe, expect, it } from 'vitest';
import { addDaysToDate, isoWeekday, localCandidates, localToUtc, toLocal, weekStartOf } from '../src/common/zoned-time.js';
import { assertDuration, localView, resolveShiftTime, temporalState } from '../src/modules/scheduling/shift-time.js';

const TJ = 'America/Tijuana';

describe('zona horaria IANA ↔ UTC (D-26, D-28)', () => {
  it('(4) America/Tijuana ↔ UTC con el offset correcto según la fecha (PDT −7 / PST −8)', () => {
    expect(localToUtc('2026-10-05', '19:00', TJ).toISOString()).toBe('2026-10-06T02:00:00.000Z'); // PDT
    expect(localToUtc('2026-12-07', '19:00', TJ).toISOString()).toBe('2026-12-08T03:00:00.000Z'); // PST
    expect(toLocal(new Date('2026-10-06T02:00:00Z'), TJ)).toEqual({ date: '2026-10-05', time: '19:00', offsetMinutes: -420 });
    expect(toLocal(new Date('2026-12-08T03:00:00Z'), TJ)).toEqual({ date: '2026-12-07', time: '19:00', offsetMinutes: -480 });
  });

  it('(6) una hora local inexistente por DST produce un error explícito (no se "corre" en silencio)', () => {
    expect(localCandidates('2026-03-08', '02:30', TJ)).toEqual([]);
    expect(() => localToUtc('2026-03-08', '02:30', TJ)).toThrow(expect.objectContaining({ code: 'LOCAL_TIME_NONEXISTENT' }));
    expect(() => localToUtc('2026-03-08', '02:30', TJ, 'LATER')).toThrow(expect.objectContaining({ code: 'LOCAL_TIME_NONEXISTENT' }));
  });

  it('(7) una hora local ambigua exige elegir; con `fold` se resuelve explícitamente', () => {
    expect(() => localToUtc('2026-11-01', '01:30', TJ)).toThrow(expect.objectContaining({ code: 'LOCAL_TIME_AMBIGUOUS' }));
    try {
      localToUtc('2026-11-01', '01:30', TJ);
    } catch (e) {
      expect((e as { details: { options: unknown[] } }).details.options).toEqual([
        { fold: 'EARLIER', utc: '2026-11-01T08:30:00.000Z', offsetMinutes: -420 },
        { fold: 'LATER', utc: '2026-11-01T09:30:00.000Z', offsetMinutes: -480 },
      ]);
    }
    expect(localToUtc('2026-11-01', '01:30', TJ, 'EARLIER').toISOString()).toBe('2026-11-01T08:30:00.000Z');
    expect(localToUtc('2026-11-01', '01:30', TJ, 'LATER').toISOString()).toBe('2026-11-01T09:30:00.000Z');
  });

  it('fechas inválidas se rechazan; aritmética de calendario sin horas', () => {
    expect(() => localToUtc('2026-02-30', '10:00', TJ)).toThrow(expect.objectContaining({ code: 'LOCAL_DATETIME_INVALID' }));
    expect(() => localToUtc('2026-02-10', '24:00', TJ)).toThrow(expect.objectContaining({ code: 'LOCAL_DATETIME_INVALID' }));
    expect(addDaysToDate('2026-10-26', 7)).toBe('2026-11-02');
    expect(isoWeekday('2026-10-05')).toBe(1);
    expect(isoWeekday('2026-10-11')).toBe(7);
    expect(weekStartOf('2026-10-11', 1)).toBe('2026-10-05');
    expect(weekStartOf('2026-10-11', 7)).toBe('2026-10-11');
  });
});

describe('tiempo de un turno (D-27)', () => {
  it('(3) "19:00 → 03:00" es UN turno: termina al día siguiente y conserva ambas fechas', () => {
    const t = resolveShiftTime({ date: '2026-10-05', startTime: '19:00', endTime: '03:00' }, TJ);
    expect(t).toMatchObject({ businessDate: '2026-10-05', endDate: '2026-10-06', minutes: 480 });
    expect(t.startsAt.toISOString()).toBe('2026-10-06T02:00:00.000Z');
    expect(t.endsAt.toISOString()).toBe('2026-10-06T10:00:00.000Z');
    expect(localView({ ...t, timezoneSnapshot: TJ })).toEqual({ startDate: '2026-10-05', startTime: '19:00', endDate: '2026-10-06', endTime: '03:00', crossesMidnight: true });
  });

  it('(5) un turno nocturno que cruza el cambio de horario dura las horas REALES (9 h el 31-oct → 1-nov)', () => {
    const fall = resolveShiftTime({ date: '2026-10-31', startTime: '22:00', endTime: '06:00' }, TJ);
    expect(fall.minutes).toBe(540);
    const spring = resolveShiftTime({ date: '2027-03-13', startTime: '22:00', endTime: '06:00' }, TJ);
    expect(spring.minutes).toBe(420);
  });

  it('(8) fin ≤ inicio en instantes se rechaza; duración fuera de la política también', () => {
    // 01:00 (PDT) → 01:30 eligiendo la SEGUNDA 01:30 (PST) es 90 min; eligiendo… ver abajo:
    expect(() => resolveShiftTime({ date: '2026-11-01', startTime: '01:45', endTime: '01:15', startFold: 'LATER', endFold: 'EARLIER' }, TJ)).not.toThrow(); // termina al día siguiente
    expect(() => resolveShiftTime({ date: '2026-11-01', startTime: '01:15', endTime: '01:45', startFold: 'LATER', endFold: 'EARLIER' }, TJ)).toThrow(expect.objectContaining({ code: 'SHIFT_END_NOT_AFTER_START' }));
    expect(() => assertDuration(30, { shiftMinMinutes: 60, shiftMaxMinutes: 960 })).toThrow(expect.objectContaining({ code: 'SHIFT_DURATION_INVALID' }));
    expect(() => assertDuration(1000, { shiftMinMinutes: 60, shiftMaxMinutes: 960 })).toThrow(expect.objectContaining({ code: 'SHIFT_DURATION_INVALID' }));
    expect(() => assertDuration(480, { shiftMinMinutes: 60, shiftMaxMinutes: 960 })).not.toThrow();
  });

  it('estado temporal: futuro / en curso / terminado', () => {
    const s = { startsAt: new Date('2026-10-06T02:00:00Z'), endsAt: new Date('2026-10-06T10:00:00Z') };
    expect(temporalState(s, new Date('2026-10-06T01:59:00Z'))).toBe('FUTURE');
    expect(temporalState(s, new Date('2026-10-06T02:00:00Z'))).toBe('IN_PROGRESS');
    expect(temporalState(s, new Date('2026-10-06T10:00:00Z'))).toBe('ENDED');
  });
});

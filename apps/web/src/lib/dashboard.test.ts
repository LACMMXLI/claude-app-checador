import { describe, expect, it } from 'vitest';
import {
  axisPercent, clock, greetingFor, initials, minutesOnDay, pendingAt, perDay, perHour, presentAt, presentSeries, shiftDate, signed, timelineAxis, toneOf, trend, type RowTimes,
} from './dashboard';

const TZ = 'America/Tijuana'; // UTC-7 en octubre
const t = (o: Partial<RowTimes>): RowTimes => ({ shiftStart: null, shiftEnd: null, in: null, out: null, ...o });

describe('minutos del día operativo', () => {
  it('convierte un instante a minutos desde las 00:00 del día operativo, también después de la medianoche', () => {
    expect(minutesOnDay('2026-10-05T21:30:00Z', TZ, '2026-10-05')).toBe(14 * 60 + 30);   // 14:30 locales
    expect(minutesOnDay('2026-10-06T08:30:00Z', TZ, '2026-10-05')).toBe(24 * 60 + 90);   // 01:30 del día siguiente
    expect(minutesOnDay('2026-10-05T10:00:00Z', TZ, '2026-10-05')).toBe(3 * 60);         // 03:00 locales
    expect(minutesOnDay('2026-10-05T10:00:00Z', TZ, '2026-10-06')).toBe(-1440 + 180);    // un día antes del día operativo
  });
  it('shiftDate suma días sin depender de la zona del navegador', () => {
    expect(shiftDate('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('presentes y por llegar en un momento', () => {
  const rows = [
    t({ shiftStart: 420, shiftEnd: 900, in: 425, out: 900 }),   // 7:00-15:00, entró 7:05, salió 15:00
    t({ shiftStart: 480, shiftEnd: 960, in: 500, out: null }),  // entró tarde 8:20, sigue
    t({ shiftStart: 480, shiftEnd: 960 }),                      // no ha llegado
    t({ in: 600, out: null }),                                  // sin turno, entró 10:00
    t({ shiftStart: 1020, shiftEnd: 1260 }),                    // turno de la tarde
  ];
  it('presentes: jornada abierta en ese minuto', () => {
    expect(presentAt(rows, 400)).toBe(0);
    expect(presentAt(rows, 430)).toBe(1);
    expect(presentAt(rows, 510)).toBe(2);
    expect(presentAt(rows, 650)).toBe(3);
    expect(presentAt(rows, 900)).toBe(2); // el de las 15:00 ya salió (la salida exacta ya no cuenta)
  });
  it('por llegar: turno ya empezado y sin entrada registrada hasta ese minuto', () => {
    expect(pendingAt(rows, 400)).toBe(0);
    expect(pendingAt(rows, 481)).toBe(2);   // el de 8:00 entró a 8:20 (aún no) y el que nunca llegó
    expect(pendingAt(rows, 510)).toBe(1);   // ya llegó el tardío
    expect(pendingAt(rows, 1030)).toBe(2);  // se suma el turno de la tarde
  });
  it('serie por hora termina en el instante actual y no inventa futuro', () => {
    expect(presentSeries(rows, 7, 12, 8 * 60 + 30)).toEqual([0, 1, 2]); // 7:00, 8:00 y "ahora" (8:30)
  });
});

describe('tendencias y conteos', () => {
  it('trend y signo', () => {
    expect(trend(18, 16)).toEqual({ delta: 2, direction: 'up' });
    expect(trend(6, 9)).toEqual({ delta: -3, direction: 'down' });
    expect(trend(4, 4)).toEqual({ delta: 0, direction: 'flat' });
    expect([signed(2), signed(-3), signed(0)]).toEqual(['+2', '−3', '0']);
  });
  it('conteos por hora y por día', () => {
    expect(perHour([420, 425, 480, 1500], 7, 9)).toEqual([2, 1, 0]);
    expect(perDay(['2026-10-05', '2026-10-05', '2026-10-03', '2026-09-20'], '2026-10-05', 7)).toEqual([0, 0, 0, 0, 1, 0, 2]);
  });
});

describe('eje de la línea de tiempo', () => {
  it('abarca los datos en horas completas, con mínimo de 8 horas y marcas legibles', () => {
    const a = timelineAxis([7.5 * 60, 21 * 60], 14 * 60 + 7);
    expect([a.start, a.end]).toEqual([420, 1260]);
    expect(a.ticks[0]).toBe(480); // la primera marca par dentro del eje
    expect(a.ticks.every((m) => m % 120 === 0)).toBe(true);
    const short = timelineAxis([600, 660], 630);
    expect(short.end - short.start).toBeGreaterThanOrEqual(480);
    const night = timelineAxis([22 * 60 + 30, 25 * 60 + 30], 23 * 60);
    expect(night.end).toBeGreaterThanOrEqual(26 * 60);
    expect(axisPercent({ start: 0, end: 100, ticks: [] }, 25)).toBe(25);
  });
  it('hora de reloj y saludo', () => {
    expect(clock(14 * 60 + 7)).toBe('14:07');
    expect(clock(25 * 60 + 30)).toBe('01:30');
    expect([greetingFor(9 * 60), greetingFor(15 * 60), greetingFor(21 * 60), greetingFor(25 * 60)]).toEqual(['morning', 'afternoon', 'evening', 'morning']);
  });
});

describe('avatares', () => {
  it('iniciales y tono estable', () => {
    expect(initials('Luis Ramírez')).toBe('LR');
    expect(initials('  ana ')).toBe('A');
    expect(initials('')).toBe('?');
    expect(toneOf('Luis Ramírez')).toBe(toneOf('Luis Ramírez'));
    expect(toneOf('x')).toBeGreaterThanOrEqual(0);
    expect(toneOf('x')).toBeLessThan(6);
  });
});

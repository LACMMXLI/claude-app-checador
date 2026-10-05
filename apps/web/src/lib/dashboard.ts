import type { Board, BoardRow } from './api';

/**
 * Cálculos del tablero de Inicio. Todo sale de los datos reales que entrega la API (tableros por sucursal, incidencias y
 * solicitudes): aquí solo se convierten a minutos del día operativo, conteos por hora/día y comparaciones "vs. ayer".
 * Funciones puras (sin red ni reloj propio) para poder probarlas.
 */

const DAY = 1440;

/** Fecha local (YYYY-MM-DD) y minutos del día de un instante en una zona IANA. */
export function localParts(instant: Date | string, tz: string): { date: string; minutes: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(instant))
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export const daysBetween = (a: string, b: string) => Math.round((Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / 86_400_000);

/** Minutos desde las 00:00 del día operativo `opDate` (pasan de 1440 si el instante cae después de la medianoche, p. ej. un turno nocturno). */
export function minutesOnDay(instant: Date | string, tz: string, opDate: string): number {
  const { date, minutes } = localParts(instant, tz);
  return daysBetween(date, opDate) * DAY + minutes;
}

export const shiftDate = (date: string, days: number) => new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + days)).toISOString().slice(0, 10);

export interface RowTimes {
  /** Inicio y fin programados (minutos del día operativo) o `null` si no hay turno. */
  shiftStart: number | null;
  shiftEnd: number | null;
  /** Entrada y salida registradas; la salida es `null` mientras la jornada siga abierta. */
  in: number | null;
  out: number | null;
}

export function rowTimes(row: BoardRow, tz: string, opDate: string): RowTimes {
  return {
    shiftStart: row.shift ? minutesOnDay(row.shift.startsAt, tz, opDate) : null,
    shiftEnd: row.shift ? minutesOnDay(row.shift.endsAt, tz, opDate) : null,
    in: row.session ? minutesOnDay(row.session.startedAt, tz, opDate) : null,
    out: row.session?.endedAt ? minutesOnDay(row.session.endedAt, tz, opDate) : null,
  };
}

export const timesOf = (board: Board) => board.rows.map((r) => rowTimes(r, board.branch.timezone, board.operationalDate));

/** Personas con la jornada abierta en el minuto `at` (entrada hecha y sin salida todavía). */
export const presentAt = (times: RowTimes[], at: number) => times.filter((t) => t.in !== null && t.in <= at && (t.out === null || t.out > at)).length;

/** Turnos que ya empezaron en `at` y cuya persona aún no había registrado entrada ("con turno y sin entrada"). */
export const pendingAt = (times: RowTimes[], at: number) => times.filter((t) => t.shiftStart !== null && t.shiftStart <= at && !(t.in !== null && t.in <= at)).length;

/** Tendencia contra el mismo momento del día anterior. */
export function trend(now: number, before: number): { delta: number; direction: 'up' | 'down' | 'flat' } {
  const delta = now - before;
  return { delta, direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat' };
}
export const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');

/** Conteo de elementos por hora (índice = hora del día operativo, 0…47) entre `from` y `to` horas. */
export function perHour(minutes: number[], fromHour: number, toHour: number): number[] {
  const out = Array.from({ length: Math.max(0, toHour - fromHour + 1) }, () => 0);
  for (const m of minutes) {
    const h = Math.floor(m / 60);
    if (h >= fromHour && h <= toHour) out[h - fromHour]! += 1;
  }
  return out;
}

/** Serie "presentes" en cada hora en punto desde `fromHour` hasta `toHour` (sin pasar de `nowMinutes`) y al final el instante actual. */
export function presentSeries(times: RowTimes[], fromHour: number, toHour: number, nowMinutes: number): number[] {
  const points: number[] = [];
  for (let h = fromHour; h <= toHour; h += 1) if (h * 60 <= nowMinutes) points.push(presentAt(times, h * 60));
  points.push(presentAt(times, nowMinutes));
  return points;
}

/** Cuenta por día de las últimas `days` fechas terminando en `endDate` (la más reciente al final). */
export function perDay(dates: string[], endDate: string, days: number): number[] {
  const out = Array.from({ length: days }, () => 0);
  for (const d of dates) {
    const idx = days - 1 - daysBetween(endDate, d);
    if (idx >= 0 && idx < days) out[idx]! += 1;
  }
  return out;
}

export interface Axis {
  start: number;
  end: number;
  ticks: number[];
}

/** Eje horario de la línea de tiempo: abarca todos los datos, en horas completas y con al menos 8 horas. Marcas cada 2 h (o cada hora si es corto). */
export function timelineAxis(minutes: number[], nowMinutes: number): Axis {
  const all = [...minutes, nowMinutes].filter((m) => Number.isFinite(m));
  let start = Math.floor(Math.min(...all) / 60) * 60;
  let end = Math.ceil(Math.max(...all) / 60) * 60;
  if (end - start < 8 * 60) {
    const pad = Math.ceil((8 * 60 - (end - start)) / 120) * 60;
    start -= pad;
    end += pad;
  }
  const step = end - start <= 10 * 60 ? 60 : 120;
  const ticks: number[] = [];
  for (let m = Math.ceil(start / step) * step; m <= end; m += step) ticks.push(m);
  return { start, end, ticks };
}
export const axisPercent = (axis: Axis, minutes: number) => ((minutes - axis.start) / (axis.end - axis.start)) * 100;
/** Hora de reloj (0–23:59) de unos minutos del día operativo. */
export const clock = (minutes: number) => `${String(Math.floor(((minutes % DAY) + DAY) % DAY / 60)).padStart(2, '0')}:${String(((minutes % 60) + 60) % 60).padStart(2, '0')}`;
export const hourLabel = (minutes: number) => `${Math.floor((((minutes % DAY) + DAY) % DAY) / 60)}:00`;

export type Greeting = 'morning' | 'afternoon' | 'evening';
export const greetingFor = (minutes: number): Greeting => {
  const h = Math.floor((((minutes % DAY) + DAY) % DAY) / 60);
  return h < 12 ? 'morning' : h < 19 ? 'afternoon' : 'evening';
};

/** Iniciales para el avatar (hasta 2 letras). */
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || '?';
/** Tono estable (0–5) a partir de un texto, para colorear avatares sin guardar nada. */
export const toneOf = (text: string) => [...text].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % 6;

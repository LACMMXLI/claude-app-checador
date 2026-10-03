/**
 * D-78 · Día operativo — ÚNICA definición en todo el sistema (asistencia, turnos, tablero, reconciliación,
 * solicitudes, correcciones, reportes y exportaciones). Mientras no llega la hora de corte del negocio/sucursal
 * (política `operational_cutoff`, en la zona IANA efectiva de la sucursal), un instante pertenece al día operativo
 * ANTERIOR. Con corte 05:00 en America/Tijuana:
 *   02-oct 23:30 ⇒ 02-oct · 03-oct 01:30 ⇒ 02-oct · 03-oct 04:59:59 ⇒ 02-oct · 03-oct 05:00:00 ⇒ 03-oct.
 * El turno pertenece al día operativo de su INICIO; una jornada ligada a un turno, al del turno; una jornada sin turno,
 * al de su Entrada. Nunca se cambian instantes: solo la fecha con la que se agrupa y se consulta.
 * Funciones puras; no hay horas de corte fijas en el código (siempre vienen de la política).
 */
import { addDaysToDate, localCandidates, toLocal } from './zoned-time.js';

/** Zona IANA efectiva de la sucursal (o del negocio) y hora de corte efectiva (`HH:MM[:SS]`). */
export interface OperationalCalendar {
  timezone: string;
  cutoff: string;
}

const hhmm = (time: string): string => time.slice(0, 5);

function addMinutesToLocalTime(time: string, minutes: number): string {
  const total = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Día operativo de un instante (la regla canónica). Los segundos no cuentan: 04:59:59 sigue antes de las 05:00. */
export function operationalDate(instant: Date, timezone: string, cutoff: string): string {
  const local = toLocal(instant, timezone);
  return local.time < hhmm(cutoff) ? addDaysToDate(local.date, -1) : local.date;
}

/** Igual que `operationalDate`, con el calendario de la sucursal. */
export const operationalDateIn = (instant: Date, calendar: OperationalCalendar): string => operationalDate(instant, calendar.timezone, calendar.cutoff);

/**
 * Instante en que ocurre la hora de corte (`HH:MM[:SS]`) del día local `date`. Si esa hora no existe
 * por un cambio de horario se usa el primer minuto válido posterior; si ocurre dos veces, la primera.
 */
export function cutoffInstant(date: string, cutoff: string, timezone: string): Date {
  const time = hhmm(cutoff);
  for (let shift = 0; shift <= 180; shift += 1) {
    const candidates = localCandidates(date, addMinutesToLocalTime(time, shift), timezone);
    if (candidates.length) return candidates[0]!;
  }
  throw new Error(`No se pudo ubicar el corte ${cutoff} del ${date} en ${timezone}`);
}

/** Intervalo `[inicio, fin)` de instantes que pertenecen al día operativo `date` (inverso de `operationalDate`). */
export function operationalDayWindow(date: string, calendar: OperationalCalendar): { start: Date; end: Date } {
  return { start: cutoffInstant(date, calendar.cutoff, calendar.timezone), end: cutoffInstant(addDaysToDate(date, 1), calendar.cutoff, calendar.timezone) };
}

/** Primer corte operativo ESTRICTAMENTE posterior a un instante (D-47: turno 19:00–03:00, corte 05:00 ⇒ 05:00). */
export function firstCutoffAfter(instant: Date, timezone: string, cutoff: string): Date {
  const date = toLocal(instant, timezone).date;
  const sameDay = cutoffInstant(date, cutoff, timezone);
  return sameDay.getTime() > instant.getTime() ? sameDay : cutoffInstant(addDaysToDate(date, 1), cutoff, timezone);
}

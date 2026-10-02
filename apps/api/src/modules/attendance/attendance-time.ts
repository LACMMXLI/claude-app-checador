/**
 * Reglas PURAS de tiempo de la asistencia (RN-CAL-06): sin base de datos, con pruebas propias.
 * Todo instante es UTC; la zona IANA efectiva de la sucursal solo interpreta (D-1, D-46). Nunca offsets fijos.
 */
import { addDaysToDate, localCandidates, toLocal } from '../../common/zoned-time.js';

/** Minutos completos entre dos instantes, truncando los segundos de cada uno (RN §9). Con signo. */
export function minutesBetween(a: Date, b: Date): number {
  return Math.floor(b.getTime() / 60_000) - Math.floor(a.getTime() / 60_000);
}

const hhmm = (time: string): string => time.slice(0, 5);

function addMinutesToLocalTime(time: string, minutes: number): string {
  const total = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

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

/**
 * D-46 · Día operativo de un instante SIN turno: antes de la hora de corte local pertenece al día anterior.
 * Corte 05:00 → 3-oct 03:30 ⇒ 2-oct · 3-oct 05:15 ⇒ 3-oct.
 */
export function operationalDate(instant: Date, timezone: string, cutoff: string): string {
  const local = toLocal(instant, timezone);
  return local.time < hhmm(cutoff) ? addDaysToDate(local.date, -1) : local.date;
}

/** Primer corte operativo ESTRICTAMENTE posterior a un instante (D-47: turno 19:00–03:00, corte 05:00 ⇒ 05:00). */
export function firstCutoffAfter(instant: Date, timezone: string, cutoff: string): Date {
  const date = toLocal(instant, timezone).date;
  const sameDay = cutoffInstant(date, cutoff, timezone);
  return sameDay.getTime() > instant.getTime() ? sameDay : cutoffInstant(addDaysToDate(date, 1), cutoff, timezone);
}

/**
 * D-43 · Estado de llegada de un turno publicado SIN Entrada (derivado, nunca guardado):
 *  antes de iniciar → UPCOMING · hasta la tolerancia → WITHIN_TOLERANCE · después → LATE_NOT_ARRIVED ·
 *  desde `absentAfterMin` → ABSENT_NOT_ARRIVED (no definitivo) · terminó sin Entrada → MISSED (falta).
 */
export type PendingArrivalState = 'UPCOMING' | 'WITHIN_TOLERANCE' | 'LATE_NOT_ARRIVED' | 'ABSENT_NOT_ARRIVED' | 'MISSED';

export function pendingArrivalState(
  shift: { startsAt: Date; endsAt: Date },
  now: Date,
  policy: { entryToleranceMin: number; absentAfterMin: number },
): PendingArrivalState {
  if (now.getTime() < shift.startsAt.getTime()) return 'UPCOMING';
  if (now.getTime() >= shift.endsAt.getTime()) return 'MISSED';
  const late = minutesBetween(shift.startsAt, now);
  if (late <= policy.entryToleranceMin) return 'WITHIN_TOLERANCE';
  if (late < policy.absentAfterMin) return 'LATE_NOT_ARRIVED';
  return 'ABSENT_NOT_ARRIVED';
}

/** D-41 · La tolerancia SOLO decide la incidencia; los minutos reales se conservan siempre. */
export const isLate = (arrivalDeltaMinutes: number, entryToleranceMin: number): boolean => arrivalDeltaMinutes > entryToleranceMin;

export interface BreakLike {
  startedAt: Date;
  endedAt: Date | null;
  durationMinutes: number | null;
  exceededMinutes: number | null;
}

/**
 * Valores derivados de una jornada (D-41, D-49, D-64, D-65). Se calculan de los instantes EFECTIVOS;
 * no se guardan (salvo duración/exceso por pausa, que son columnas generadas). No descuentan pausas.
 */
export function sessionMetrics(
  session: { startedAt: Date; endedAt: Date | null },
  shift: { startsAt: Date; endsAt: Date } | null,
  breaksList: readonly BreakLike[],
  now: Date,
) {
  const closed = breaksList.filter((b) => b.endedAt !== null);
  return {
    /** Entrada efectiva − inicio programado (negativo = antes). */
    arrivalDeltaMinutes: shift ? minutesBetween(shift.startsAt, session.startedAt) : null,
    /** Salida efectiva − fin programado (negativo = salida anticipada). Sin sanción automática. */
    departureDeltaMinutes: shift && session.endedAt ? minutesBetween(shift.endsAt, session.endedAt) : null,
    scheduledMinutes: shift ? minutesBetween(shift.startsAt, shift.endsAt) : null,
    /** Duración real (solo si hay Salida; nunca se inventa). */
    elapsedMinutes: session.endedAt ? minutesBetween(session.startedAt, session.endedAt) : null,
    /** Tiempo transcurrido de una jornada aún abierta (para el tablero). */
    runningMinutes: session.endedAt ? null : Math.max(0, minutesBetween(session.startedAt, now)),
    breakCount: breaksList.length,
    breakMinutes: closed.reduce((sum, b) => sum + (b.durationMinutes ?? 0), 0),
    breakExcessMinutes: closed.reduce((sum, b) => sum + (b.exceededMinutes ?? 0), 0),
    openBreak: breaksList.some((b) => b.endedAt === null),
  };
}

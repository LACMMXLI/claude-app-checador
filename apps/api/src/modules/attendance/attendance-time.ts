/**
 * Reglas PURAS de tiempo de la asistencia (RN-CAL-06): sin base de datos, con pruebas propias.
 * Todo instante es UTC; la zona IANA efectiva de la sucursal solo interpreta (D-1, D-46). Nunca offsets fijos.
 */

/** Minutos completos entre dos instantes, truncando los segundos de cada uno (RN §9). Con signo. */
export function minutesBetween(a: Date, b: Date): number {
  return Math.floor(b.getTime() / 60_000) - Math.floor(a.getTime() / 60_000);
}

// D-46/D-78: el día operativo tiene UNA sola definición, en `src/common/operational-day.ts`.
export { cutoffInstant, firstCutoffAfter, operationalDate } from '../../common/operational-day.js';

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

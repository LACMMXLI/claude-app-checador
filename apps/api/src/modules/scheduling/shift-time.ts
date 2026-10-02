import { DomainError } from '../../common/errors.js';
import { addDaysToDate, type Fold, isValidLocalTime, localToUtc, toLocal } from '../../common/zoned-time.js';

/**
 * Reglas puras de tiempo de un turno (D-26, D-27, D-28).
 *  - El día del turno (business_date) es la fecha LOCAL en que inicia.
 *  - Si la hora de fin es ≤ la de inicio, el turno termina al día siguiente (un solo turno, sin partirlo).
 *  - Las horas locales se convierten con la zona IANA (DST explícito: inexistente/ambigua ⇒ error o `fold`).
 */
export interface LocalShiftInput {
  date: string; // YYYY-MM-DD (día en que inicia)
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  startFold?: Fold;
  endFold?: Fold;
}

export interface ResolvedShiftTime {
  businessDate: string;
  endDate: string;
  startsAt: Date;
  endsAt: Date;
  minutes: number;
}

export function resolveShiftTime(input: LocalShiftInput, timezone: string): ResolvedShiftTime {
  if (!isValidLocalTime(input.startTime) || !isValidLocalTime(input.endTime)) {
    throw new DomainError('LOCAL_DATETIME_INVALID', { startTime: input.startTime, endTime: input.endTime });
  }
  const endDate = input.endTime > input.startTime ? input.date : addDaysToDate(input.date, 1);
  const startsAt = localToUtc(input.date, input.startTime, timezone, input.startFold);
  const endsAt = localToUtc(endDate, input.endTime, timezone, input.endFold);
  if (endsAt.getTime() <= startsAt.getTime()) throw new DomainError('SHIFT_END_NOT_AFTER_START');
  return { businessDate: input.date, endDate, startsAt, endsAt, minutes: Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000) };
}

export function assertDuration(minutes: number, policy: { shiftMinMinutes: number; shiftMaxMinutes: number }) {
  if (minutes < policy.shiftMinMinutes || minutes > policy.shiftMaxMinutes) {
    throw new DomainError('SHIFT_DURATION_INVALID', { minutes, min: policy.shiftMinMinutes, max: policy.shiftMaxMinutes });
  }
}

export type ShiftTemporalState = 'FUTURE' | 'IN_PROGRESS' | 'ENDED';

/** D-32: un turno futuro se edita normalmente; uno que ya comenzó o terminó es "histórico". */
export function temporalState(shift: { startsAt: Date; endsAt: Date }, now: Date): ShiftTemporalState {
  if (now.getTime() < shift.startsAt.getTime()) return 'FUTURE';
  if (now.getTime() < shift.endsAt.getTime()) return 'IN_PROGRESS';
  return 'ENDED';
}

/** Vista local de un turno, SIEMPRE con la zona con la que se creó (no con la actual de la sucursal). */
export function localView(shift: { startsAt: Date; endsAt: Date; timezoneSnapshot: string; businessDate: string }) {
  const start = toLocal(shift.startsAt, shift.timezoneSnapshot);
  const end = toLocal(shift.endsAt, shift.timezoneSnapshot);
  return {
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    crossesMidnight: end.date !== shift.businessDate,
  };
}

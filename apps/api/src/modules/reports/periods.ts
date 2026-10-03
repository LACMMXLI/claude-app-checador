import { DomainError } from '../../common/errors.js';
import { addDaysToDate, weekStartOf } from '../../common/zoned-time.js';

/**
 * Periodos rápidos de reportes (D-73), siempre por DÍA OPERATIVO. Cubren los accesos de D-10:
 * Hoy · Ayer · Semana (actual/anterior, con `week_start_day`) · Quincena (1–15 / 16–fin, actual/anterior) ·
 * Mes (actual/anterior). Función pura.
 */
export type PeriodKey =
  | 'today'
  | 'yesterday'
  | 'week_current'
  | 'week_previous'
  | 'fortnight_current'
  | 'fortnight_previous'
  | 'month_current'
  | 'month_previous';
export const PERIOD_KEYS: readonly PeriodKey[] = ['today', 'yesterday', 'week_current', 'week_previous', 'fortnight_current', 'fortnight_previous', 'month_current', 'month_previous'];

export const MAX_REPORT_DAYS = 366;

const lastDayOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate(); // month 1-12
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function quickPeriods(today: string, weekStartDay: number): Record<PeriodKey, { from: string; to: string }> {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const prevMonth = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const week = weekStartOf(today, weekStartDay);
  const firstHalf = d <= 15;
  return {
    today: { from: today, to: today },
    yesterday: { from: addDaysToDate(today, -1), to: addDaysToDate(today, -1) },
    week_current: { from: week, to: addDaysToDate(week, 6) },
    week_previous: { from: addDaysToDate(week, -7), to: addDaysToDate(week, -1) },
    fortnight_current: firstHalf ? { from: iso(y, m, 1), to: iso(y, m, 15) } : { from: iso(y, m, 16), to: iso(y, m, lastDayOfMonth(y, m)) },
    fortnight_previous: firstHalf
      ? { from: iso(prevMonth.y, prevMonth.m, 16), to: iso(prevMonth.y, prevMonth.m, lastDayOfMonth(prevMonth.y, prevMonth.m)) }
      : { from: iso(y, m, 1), to: iso(y, m, 15) },
    month_current: { from: iso(y, m, 1), to: iso(y, m, lastDayOfMonth(y, m)) },
    month_previous: { from: iso(prevMonth.y, prevMonth.m, 1), to: iso(prevMonth.y, prevMonth.m, lastDayOfMonth(prevMonth.y, prevMonth.m)) },
  };
}

/** Rango personalizado validado: desde ≤ hasta y como máximo 366 días (decisión 7). */
export function assertRange(from: string, to: string): void {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (!Number.isFinite(days) || days < 1) throw new DomainError('VALIDATION_ERROR', { fields: ['from', 'to'] });
  if (days > MAX_REPORT_DAYS) throw new DomainError('REPORT_RANGE_TOO_LONG', { maxDays: MAX_REPORT_DAYS, days });
}

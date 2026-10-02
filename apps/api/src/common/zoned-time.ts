/**
 * Conversión hora local ↔ UTC con zonas IANA (D-26, D-28). Nunca se asume un offset fijo: el offset se
 * obtiene de la base de datos de zonas (Intl) para cada instante, así que el horario de verano (DST)
 * queda cubierto. Las horas locales que NO existen (salto de primavera) o que existen DOS veces
 * (regreso de otoño) se detectan y se informan; nunca se "acomoda" otra hora en silencio.
 */
import { DomainError } from './errors.js';

export type Fold = 'EARLIER' | 'LATER';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  offsetMinutes: number; // local − UTC, en minutos (p. ej. −480 en Tijuana en invierno)
}

/** Fecha/hora local de un instante en una zona IANA. */
export function toLocal(instant: Date, tz: string): LocalParts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(instant).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return { date, time, offsetMinutes: Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000) };
}

function parseLocal(date: string, time: string): number {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) throw new DomainError('LOCAL_DATETIME_INVALID', { date, time });
  const ms = Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!, +t[1]!, +t[2]!);
  // Rechaza fechas imposibles (p. ej. 2026-02-30)
  if (new Date(ms).toISOString().slice(0, 10) !== date) throw new DomainError('LOCAL_DATETIME_INVALID', { date, time });
  return ms;
}

/**
 * Todos los instantes UTC cuya hora local en `tz` es exactamente `date time`.
 *   0 resultados → hora inexistente (salto DST) · 1 → normal · 2 → ambigua (se repite).
 */
export function localCandidates(date: string, time: string, tz: string): Date[] {
  const naive = parseLocal(date, time);
  const offsets = new Set<number>();
  for (const probe of [-2, -1, 0, 1, 2]) offsets.add(toLocal(new Date(naive + probe * 86_400_000), tz).offsetMinutes);
  const found = new Map<number, Date>();
  for (const offset of offsets) {
    const candidate = new Date(naive - offset * 60_000);
    const back = toLocal(candidate, tz);
    if (back.date === date && back.time === time) found.set(candidate.getTime(), candidate);
  }
  return [...found.values()].sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Hora local → instante UTC. Errores explícitos:
 *  - LOCAL_TIME_NONEXISTENT: la hora no existe ese día (cambio de horario).
 *  - LOCAL_TIME_AMBIGUOUS: la hora ocurre dos veces y no se indicó `fold` (EARLIER = primera, LATER = segunda).
 */
export function localToUtc(date: string, time: string, tz: string, fold?: Fold): Date {
  const candidates = localCandidates(date, time, tz);
  if (candidates.length === 0) throw new DomainError('LOCAL_TIME_NONEXISTENT', { date, time, timezone: tz });
  if (candidates.length === 1) return candidates[0]!;
  if (!fold) {
    throw new DomainError('LOCAL_TIME_AMBIGUOUS', {
      date,
      time,
      timezone: tz,
      options: candidates.map((c, i) => ({ fold: i === 0 ? 'EARLIER' : 'LATER', utc: c.toISOString(), offsetMinutes: toLocal(c, tz).offsetMinutes })),
    });
  }
  return fold === 'EARLIER' ? candidates[0]! : candidates[candidates.length - 1]!;
}

/** Suma días a una fecha de calendario (sin horas: no le afecta el DST). */
export function addDaysToDate(date: string, days: number): string {
  const ms = parseLocal(date, '00:00') + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Día ISO de la semana (1 = lunes … 7 = domingo) de una fecha de calendario. */
export function isoWeekday(date: string): number {
  const d = new Date(parseLocal(date, '00:00')).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Primer día de la semana que contiene `date`, según `weekStartDay` (1 = lunes … 7 = domingo). */
export function weekStartOf(date: string, weekStartDay: number): string {
  const diff = (isoWeekday(date) - weekStartDay + 7) % 7;
  return addDaysToDate(date, -diff);
}

export function isValidLocalTime(time: string): boolean {
  return TIME_RE.test(time);
}

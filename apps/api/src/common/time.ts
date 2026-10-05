/** ¿Es una zona horaria IANA válida ("Region/Ciudad" o "UTC")? */
export function isValidTimezone(tz: string): boolean {
  if (tz !== 'UTC' && !tz.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Fecha local (YYYY-MM-DD) de un instante en una zona. Los instantes se guardan en UTC; la zona solo interpreta. */
export function localDate(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

/** Zona efectiva: la de la sucursal si la sobrescribe; si no, la del negocio. */
export function effectiveTimezone(branchTimezone: string | null | undefined, organizationTimezone: string): string {
  return branchTimezone ?? organizationTimezone;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Día de la semana ISO de una fecha `YYYY-MM-DD`: 1 = lunes … 7 = domingo. */
export function isoWeekday(isoDate: string): number {
  const d = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Edad cumplida en años en `today` (`YYYY-MM-DD`); `null` si no hay fecha de nacimiento. */
export function ageOn(birthDate: string | null | undefined, today: string): number | null {
  if (!birthDate) return null;
  const [by, bm, bd] = birthDate.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  const years = ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
  return years < 0 ? null : years;
}

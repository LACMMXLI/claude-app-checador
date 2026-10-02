/** Formatos de presentación (es-MX). Las horas vienen ya en la zona del turno desde la API. */
export function hour12(time: string): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const suffix = h < 12 ? 'a' : 'p';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

/** "7p–3a (+1)": el (+1) indica que termina al día siguiente. */
export function shiftLabel(s: { startTime: string; endTime: string; crossesMidnight: boolean }): string {
  return `${hour12(s.startTime)}–${hour12(s.endTime)}${s.crossesMidnight ? ' (+1)' : ''}`;
}

export function minutesLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const DAY = new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export function dayLabel(date: string): string {
  return DAY.format(new Date(`${date}T00:00:00Z`));
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function todayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Hora local de un instante en la zona de la sucursal (los instantes vienen en UTC). */
export function timeIn(iso: string | null | undefined, tz: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('es-MX', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));
}

export function dateTimeIn(iso: string | null | undefined, tz: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));
}

/** Fecha y hora local (para prellenar formularios de corrección). */
export function localParts(iso: string, tz: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** "+12 min" / "−20 min" / "0 min" (diferencias reales contra el turno). */
export function signedMinutes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n > 0 ? `+${n} min` : n < 0 ? `−${Math.abs(n)} min` : '0 min';
}

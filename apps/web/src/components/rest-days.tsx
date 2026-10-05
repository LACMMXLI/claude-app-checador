'use client';

import { t } from '@/lib/i18n';

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** "Sáb, Dom" o "Sin día fijo". */
export function restDaysLabel(days: readonly number[]): string {
  return days.length === 0 ? t('employees.restNone') : [...days].sort((a, b) => a - b).map((d) => t(`days.short.${d}`)).join(', ');
}

/** Selector de días de descanso (lunes = 1 … domingo = 7). No permite marcar los 7. */
export function RestDaysPicker({ value, onChange, disabled }: { value: number[]; onChange: (days: number[]) => void; disabled?: boolean }) {
  const toggle = (d: number) => {
    const next = value.includes(d) ? value.filter((x) => x !== d) : [...value, d].sort((a, b) => a - b);
    if (next.length <= 6) onChange(next);
  };
  return (
    <fieldset className="rest-picker" disabled={disabled}>
      <legend>{t('employees.restDays')}</legend>
      <div className="chips">
        {DAYS.map((d) => (
          <label key={d} className={`chip ${value.includes(d) ? 'on' : ''}`}>
            <input type="checkbox" checked={value.includes(d)} onChange={() => toggle(d)} aria-label={t(`days.long.${d}`)} />
            <span aria-hidden="true">{t(`days.short.${d}`)}</span>
          </label>
        ))}
      </div>
      <p className="muted hint">{t('employees.restDaysHint')}</p>
    </fieldset>
  );
}

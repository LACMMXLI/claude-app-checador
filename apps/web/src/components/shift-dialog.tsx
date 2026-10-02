'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { api, ApiError, type Shift, type Week } from '@/lib/api';
import { dayLabel, minutesLabel } from '@/lib/format';
import { errorText, t } from '@/lib/i18n';
import { ErrorBox, Field } from './ui';

interface HistoryRow { id: number; occurredAt: string; action: string; reason: string | null; before: Partial<Shift> | null; after: Partial<Shift> | null }

/** Alta/edición de un turno. Envía la `version` vista: si alguien lo cambió antes, la API responde conflicto. */
export function ShiftDialog({ week, shift, preset, onClose, onSaved }: {
  week: Week;
  shift: Shift | null;
  preset?: { employeeId: string; date: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    employeeId: shift?.employeeId ?? preset?.employeeId ?? '',
    date: shift?.businessDate ?? preset?.date ?? week.days[0]!,
    startTime: shift?.startTime ?? '07:00',
    endTime: shift?.endTime ?? '15:00',
    notes: shift?.notes ?? '',
    reason: '',
  });
  const [fold, setFold] = useState<{ start?: 'EARLIER' | 'LATER'; end?: 'EARLIER' | 'LATER' }>({});
  const [ambiguous, setAmbiguous] = useState<null | 'start' | 'end'>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const cancelled = shift?.status === 'CANCELLED';

  useEffect(() => {
    if (shift) void api<HistoryRow[]>(`/shifts/${shift.id}/history`).then(setHistory).catch(() => setHistory([]));
  }, [shift]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onSaved();
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.code === 'LOCAL_TIME_AMBIGUOUS') {
        setAmbiguous(err.details.time === form.startTime ? 'start' : 'end');
      }
      setError(errorText(err?.code));
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const body = {
      employeeId: form.employeeId,
      date: form.date,
      startTime: form.startTime,
      endTime: form.endTime,
      notes: form.notes || null,
      startFold: fold.start,
      endFold: fold.end,
      reason: form.reason || undefined,
    };
    void run(() =>
      shift
        ? api(`/shifts/${shift.id}`, { method: 'PATCH', body: { ...body, expectedVersion: shift.version } })
        : api('/shifts', { method: 'POST', body: { ...body, branchId: week.branch.id } }),
    );
  }

  function cancelShift() {
    if (!shift) return;
    const reason = form.reason || window.prompt(t('common.reason')) || '';
    if (!reason.trim()) return setError(t('errors.REASON_REQUIRED'));
    void run(() => api(`/shifts/${shift.id}/cancel`, { method: 'POST', body: { expectedVersion: shift.version, reason } }));
  }

  function deleteShift() {
    if (!shift) return;
    void run(() => api(`/shifts/${shift.id}?expectedVersion=${shift.version}${form.reason ? `&reason=${encodeURIComponent(form.reason)}` : ''}`, { method: 'DELETE' }));
  }

  return (
    <div className="overlay" role="dialog" aria-label={shift ? t('schedule.editShift') : t('schedule.newShift')}>
      <div className="card dialog">
        <header className="card-header">
          <h2>{shift ? t('schedule.editShift') : t('schedule.newShift')}</h2>
          <button className="link" onClick={onClose}>✕</button>
        </header>
        {shift && (
          <p className="muted">
            {shift.startDate} {shift.startTime} → {shift.endDate} {shift.endTime} · {minutesLabel(shift.scheduledMinutes)} · {shift.timezone}
            {cancelled && <> · <strong>{t('schedule.cancelled')}</strong>: {shift.cancelReason}</>}
          </p>
        )}
        <form className="stack" onSubmit={save}>
          <div className="row">
            <Field label={t('schedule.employee')}>
              <select required disabled={cancelled} value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
                <option value="" />
                {week.employees.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
              </select>
            </Field>
            <Field label={t('schedule.date')}>
              <select disabled={cancelled} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })}>
                {week.days.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}
              </select>
            </Field>
          </div>
          <div className="row">
            <Field label={t('schedule.start')}><input type="time" required disabled={cancelled} value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} /></Field>
            <Field label={t('schedule.end')}><input type="time" required disabled={cancelled} value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} /></Field>
          </div>
          {form.endTime <= form.startTime && <p className="muted">↳ termina al día siguiente (+1)</p>}
          {ambiguous && (
            <Field label={t('schedule.fold')}>
              <select value={fold[ambiguous] ?? ''} onChange={(e) => setFold({ ...fold, [ambiguous]: (e.target.value || undefined) as 'EARLIER' | 'LATER' | undefined })}>
                <option value="" />
                <option value="EARLIER">{t('schedule.fold.EARLIER')}</option>
                <option value="LATER">{t('schedule.fold.LATER')}</option>
              </select>
            </Field>
          )}
          <Field label={t('schedule.notes')}><input disabled={cancelled} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          <Field label={`${t('common.reason')} (obligatorio para cancelar o corregir turnos pasados)`}><input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          <ErrorBox message={error} />
          {!cancelled && (
            <div className="row">
              <button className="primary" disabled={busy}>{t('common.save')}</button>
              {shift && <button type="button" disabled={busy} onClick={cancelShift}>{t('schedule.cancelShift')}</button>}
              {shift && shift.scheduleStatus === 'DRAFT' && <button type="button" disabled={busy} onClick={deleteShift}>{t('schedule.deleteShift')}</button>}
            </div>
          )}
        </form>
        {history && history.length > 0 && (
          <details>
            <summary>{t('schedule.history')} ({history.length})</summary>
            <ul>
              {history.map((h) => (
                <li key={h.id}>
                  {new Date(h.occurredAt).toLocaleString('es-MX')} · <code>{h.action}</code>
                  {h.before?.startTime && h.after?.startTime ? ` · ${h.before.startTime}–${h.before.endTime} → ${h.after.startTime}–${h.after.endTime}` : ''}
                  {h.reason ? ` · ${h.reason}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

'use client';

import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { StateBadge } from '@/components/attendance';
import { Card, Empty, ErrorBox, Field, Loading, useAction, useLoad } from '@/components/ui';
import Link from 'next/link';
import { api, type CorrectionRequest, personName, type SessionDetail } from '@/lib/api';
import { dateTimeIn, localParts, minutesLabel, shiftLabel, signedMinutes, timeIn } from '@/lib/format';
import { t } from '@/lib/i18n';

type Action = 'SET_CLOCK_IN' | 'SET_CLOCK_OUT' | 'SET_BREAK_START' | 'SET_BREAK_END' | 'ADD_BREAK' | 'LINK_SHIFT' | 'UNLINK_SHIFT';

/** Lo que una corrección cambió, en palabras (original → corregido). */
function describeValue(v: Record<string, unknown> | null, tz: string): string {
  if (!v) return '—';
  return Object.entries(v)
    .map(([k, val]) => {
      const label = t(`att.field.${k}`);
      if (k === 'status' && typeof val === 'string') return `${label}: ${t(`att.session.status.${val}`)}`;
      if (k === 'shiftId') return `${label}: ${val ? t('att.field.linked') : t('att.noShift')}`;
      return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(val) ? `${label}: ${dateTimeIn(val, tz)}` : `${label}: ${val ?? '—'}`;
    })
    .join(' · ');
}

/**
 * Detalle de una jornada: PROGRAMADO (turno) · REGISTRADO (eventos físicos, intactos) · EFECTIVO (tras
 * correcciones) · pausas · incidencias · correcciones y auditoría. Las correcciones son acciones de dominio
 * (no un formulario genérico); motivo siempre obligatorio y nunca sobre la propia jornada.
 */
export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: d, error, reload } = useLoad(() => api<SessionDetail>(`/attendance/sessions/${id}`), [id]);
  const action = useAction();
  const [form, setForm] = useState<{ action: Action; date: string; time: string; endDate: string; endTime: string; breakId: string; shiftId: string; reason: string }>({ action: 'SET_CLOCK_IN', date: '', time: '', endDate: '', endTime: '', breakId: '', shiftId: '', reason: '' });
  // solicitudes ligadas a esta jornada (D-70) por su vínculo, no por fecha (una corrección puede cambiar su día operativo)
  const requests = useLoad(
    () => (d ? api<CorrectionRequest[]>(`/attendance/correction-requests?workSessionId=${d.effective.id}`) : Promise.resolve([])),
    [d?.effective.id, d?.effective.version],
  );
  const [resolveReason, setResolveReason] = useState('');

  useEffect(() => {
    if (!d || form.date) return;
    const p = localParts(d.effective.startedAt, d.branch.timezone);
    setForm((f) => ({ ...f, date: p.date, time: p.time }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);

  if (!d) return error ? <ErrorBox message={error} /> : <Loading />;
  const tz = d.branch.timezone;
  const e = d.effective;
  const state = e.status === 'REVIEW' ? 'NEEDS_REVIEW' : e.status === 'CLOSED' ? 'LEFT' : e.onBreak ? 'ON_BREAK' : 'WORKING';

  const available: Action[] = [
    'SET_CLOCK_IN',
    'SET_CLOCK_OUT',
    ...(d.breaks.length ? (['SET_BREAK_START', 'SET_BREAK_END'] as Action[]) : []),
    'ADD_BREAK',
    ...(e.shiftId ? (['UNLINK_SHIFT'] as Action[]) : d.linkableShifts.length ? (['LINK_SHIFT'] as Action[]) : []),
  ];

  function prefill(next: Action, breakId = form.breakId) {
    const brk = d!.breaks.find((b) => b.id === breakId) ?? d!.breaks[0];
    const source =
      next === 'SET_CLOCK_IN' ? e.startedAt : next === 'SET_CLOCK_OUT' ? e.endedAt : next === 'SET_BREAK_START' ? brk?.startedAt : next === 'SET_BREAK_END' ? brk?.endedAt : null;
    const parts = source ? localParts(source, tz) : localParts(next === 'ADD_BREAK' ? e.startedAt : new Date().toISOString(), tz);
    setForm({ ...form, action: next, breakId: brk?.id ?? '', shiftId: d!.linkableShifts[0]?.id ?? '', date: parts.date, time: parts.time, endDate: parts.date, endTime: parts.time });
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const at = { date: form.date, time: form.time };
    const body =
      form.action === 'LINK_SHIFT' ? { action: form.action, shiftId: form.shiftId }
      : form.action === 'UNLINK_SHIFT' ? { action: form.action }
      : form.action === 'SET_BREAK_START' || form.action === 'SET_BREAK_END' ? { action: form.action, breakId: form.breakId, at }
      : form.action === 'ADD_BREAK' ? { action: form.action, start: at, end: { date: form.endDate, time: form.endTime } }
      : { action: form.action, at };
    const ok = await action.run(() => api(`/attendance/sessions/${id}/corrections`, { method: 'POST', body: { ...body, expectedVersion: e.version, reason: form.reason } }));
    if (ok) {
      setForm({ ...form, reason: '' });
      await reload();
    }
  }

  async function resolve(incidentId: string, version: number, resolution: 'JUSTIFIED' | 'CONFIRMED' | 'DISMISSED') {
    if (await action.run(() => api(`/attendance/incidents/${incidentId}/resolve`, { method: 'POST', body: { resolution, expectedVersion: version, reason: resolveReason } }))) {
      setResolveReason('');
      await reload();
    }
  }

  return (
    <>
      <h1>{t('att.detail.title')} · {personName(d.employee)} <StateBadge state={state} /></h1>
      <p className="muted">{d.branch.name} · {t('live.date')} {e.operationalDate} · {t(`att.origin.${e.origin}`)}</p>
      <ErrorBox message={action.error} />

      <div className="compare">
        <Card title={t('att.detail.scheduled')}>
          {d.scheduled ? (
            <dl data-testid="scheduled">
              <dt>{t('att.shift')}</dt><dd>{shiftLabel(d.scheduled)} · {d.scheduled.businessDate}</dd>
              <dt>{t('schedule.duration')}</dt><dd>{minutesLabel(d.scheduled.scheduledMinutes)}</dd>
            </dl>
          ) : <p className="muted">{t('att.noShift')}</p>}
        </Card>
        <Card title={t('att.detail.effective')}>
          <dl data-testid="effective">
            <dt>{t('att.in')}</dt><dd>{dateTimeIn(e.startedAt, tz)}</dd>
            <dt>{t('att.out')}</dt><dd>{e.endedAt ? dateTimeIn(e.endedAt, tz) : t('att.open')}</dd>
            <dt>{t('att.arrival')}</dt><dd>{signedMinutes(e.metrics.arrivalDeltaMinutes)}</dd>
            <dt>{t('att.departure')}</dt><dd>{signedMinutes(e.metrics.departureDeltaMinutes)}</dd>
            <dt>{t('att.elapsed')}</dt><dd>{e.metrics.elapsedMinutes !== null ? minutesLabel(e.metrics.elapsedMinutes) : '—'}</dd>
            <dt>{t('att.breaks')}</dt><dd>{e.metrics.breakMinutes} min · {t('att.breakExcess')} {e.metrics.breakExcessMinutes} min</dd>
          </dl>
        </Card>
      </div>

      <Card title={t('att.detail.recorded')}>
        {d.recorded.length === 0 ? <p className="muted">{t('att.detail.noEvents')}</p> : (
          <table data-testid="recorded">
            <thead><tr><th>{t('audit.action')}</th><th>{t('audit.when')}</th><th>{t('att.detail.device')}</th><th>{t('common.branch')}</th><th>{t('att.detail.received')}</th></tr></thead>
            <tbody>
              {d.recorded.map((ev) => (
                <tr key={ev.id}><td>{t(`kiosk.action.${ev.type}`)}</td><td>{timeIn(ev.occurredAt, tz)}</td><td>{ev.device}</td><td>{ev.branchName}</td><td>{dateTimeIn(ev.receivedAt, tz)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title={t('att.breaks')}>
        {d.breaks.length === 0 ? <Empty /> : (
          <table>
            <thead><tr><th>#</th><th>{t('kiosk.action.BREAK_START')}</th><th>{t('kiosk.action.BREAK_END')}</th><th>{t('schedule.duration')}</th><th>{t('att.breakExcess')}</th></tr></thead>
            <tbody>
              {d.breaks.map((b) => (
                <tr key={b.id}>
                  <td>{b.sequence}</td><td>{timeIn(b.startedAt, tz)}</td><td>{b.endedAt ? timeIn(b.endedAt, tz) : t('att.open')}</td>
                  <td>{b.durationMinutes ?? '—'} / {b.allowedMinutes} min</td><td className={b.exceededMinutes ? 'late' : ''}>{b.exceededMinutes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title={t('att.incidents')}>
        {d.incidents.length === 0 ? <Empty /> : (
          <>
            <table>
              <tbody>
                {d.incidents.map((i) => (
                  <tr key={i.id}>
                    <td>{t(`incident.type.${i.type}`)}</td>
                    <td>{t(`incident.status.${i.status}`)}{i.resolution ? ` · ${t(`incident.resolution.${i.resolution}`)}` : ''}</td>
                    <td className="muted">{i.resolutionReason ?? ''}</td>
                    <td>
                      {i.status === 'OPEN' && d.permissions.canResolveIncidents && (
                        <span className="row">
                          {(['JUSTIFIED', 'CONFIRMED', 'DISMISSED'] as const).map((r) => (
                            <button key={r} disabled={!resolveReason.trim() || action.busy} onClick={() => void resolve(i.id, i.version, r)}>{t(`incident.resolution.${r}`)}</button>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.permissions.canResolveIncidents && d.incidents.some((i) => i.status === 'OPEN') && (
              <Field label={`${t('common.reason')} (${t('incident.resolve')})`}><input value={resolveReason} onChange={(ev) => setResolveReason(ev.target.value)} /></Field>
            )}
          </>
        )}
      </Card>

      <Card title={t('att.correct.title')}>
        {d.permissions.isSelf ? <p className="muted">{t('att.correct.self')}</p> : !d.permissions.canCorrect ? <p className="muted">{t('errors.FORBIDDEN')}</p> : (
          <form className="stack" onSubmit={submit} data-testid="correction-form">
            <div className="row">
              <Field label={t('att.correct.action')}>
                <select value={form.action} onChange={(ev) => prefill(ev.target.value as Action)}>
                  {available.map((a) => <option key={a} value={a}>{t(`att.correct.${a}`)}</option>)}
                </select>
              </Field>
              {(form.action === 'SET_BREAK_START' || form.action === 'SET_BREAK_END') && (
                <Field label={t('att.correct.break')}>
                  <select value={form.breakId} onChange={(ev) => prefill(form.action, ev.target.value)}>
                    {d.breaks.map((b) => <option key={b.id} value={b.id}>#{b.sequence}</option>)}
                  </select>
                </Field>
              )}
              {form.action === 'LINK_SHIFT' && (
                <Field label={t('att.correct.shift')}>
                  <select value={form.shiftId} onChange={(ev) => setForm({ ...form, shiftId: ev.target.value })}>
                    {d.linkableShifts.map((s) => <option key={s.id} value={s.id}>{s.businessDate} · {shiftLabel(s)}</option>)}
                  </select>
                </Field>
              )}
              {form.action.startsWith('SET_') && (
                <>
                  <Field label={t('att.correct.date')}><input type="date" required value={form.date} onChange={(ev) => setForm({ ...form, date: ev.target.value })} /></Field>
                  <Field label={t('att.correct.time')}><input type="time" required value={form.time} onChange={(ev) => setForm({ ...form, time: ev.target.value })} /></Field>
                </>
              )}
              {form.action === 'ADD_BREAK' && (
                <>
                  <Field label={`${t('att.correct.breakStart')} · ${t('att.correct.date')}`}><input type="date" required value={form.date} onChange={(ev) => setForm({ ...form, date: ev.target.value })} /></Field>
                  <Field label={`${t('att.correct.breakStart')} · ${t('att.correct.time')}`}><input type="time" required value={form.time} onChange={(ev) => setForm({ ...form, time: ev.target.value })} /></Field>
                  <Field label={`${t('att.correct.breakEnd')} · ${t('att.correct.date')}`}><input type="date" required value={form.endDate} onChange={(ev) => setForm({ ...form, endDate: ev.target.value })} /></Field>
                  <Field label={`${t('att.correct.breakEnd')} · ${t('att.correct.time')}`}><input type="time" required value={form.endTime} onChange={(ev) => setForm({ ...form, endTime: ev.target.value })} /></Field>
                </>
              )}
            </div>
            <Field label={t('common.reason')}><input required value={form.reason} onChange={(ev) => setForm({ ...form, reason: ev.target.value })} /></Field>
            <div><button className="primary" disabled={action.busy || !form.reason.trim() || ((form.action.startsWith('SET_') || form.action === 'ADD_BREAK') && !form.time) || (form.action === 'ADD_BREAK' && !form.endTime)}>{t('att.correct.submit')}</button></div>
          </form>
        )}
      </Card>

      <Card title={t('att.corrections')}>
        {d.corrections.length === 0 ? <Empty /> : (
          <table data-testid="corrections">
            <thead><tr><th>{t('audit.when')}</th><th>{t('att.correct.action')}</th><th>{t('att.correct.original')}</th><th>{t('att.correct.corrected')}</th><th>{t('att.correct.by')}</th><th>{t('common.reason')}</th></tr></thead>
            <tbody>
              {d.corrections.map((c) => (
                <tr key={c.id}>
                  <td>{dateTimeIn(c.correctedAt, tz)}</td><td>{t(`att.correct.${c.action}`)}</td>
                  <td>{describeValue(c.originalValue, tz)}</td><td>{describeValue(c.correctedValue, tz)}</td>
                  <td>{c.correctedBy.displayName}</td><td>{c.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title={t('att.detail.requests')}>
        {(() => {
          const mine = requests.data ?? [];
          return mine.length === 0 ? <p className="muted">{t('req.empty')}</p> : (
            <table data-testid="session-requests">
              <tbody>
                {mine.map((r) => (
                  <tr key={r.id}>
                    <td>{dateTimeIn(r.createdAt, tz)}</td><td>{t(`req.action.${r.action}`)}</td>
                    <td><span className={`badge req-${r.status}`}>{t(`req.status.${r.status}`)}</span></td>
                    <td className="muted">{r.reason}</td>
                    <td><Link href={`/solicitudes?id=${r.id}`}>{t('att.detail')}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        })()}
      </Card>

      <Card title={t('att.detail.audit')}>
        <table>
          <tbody>
            {d.audit.map((a) => (
              <tr key={a.id}><td>{dateTimeIn(a.occurredAt, tz)}</td><td><code>{a.action}</code></td><td>{a.actor ?? a.actorType}</td><td className="muted">{a.reason ?? ''}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

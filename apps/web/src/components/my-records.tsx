'use client';

import { useState } from 'react';
import type { LocalInstant, OwnRecords, RequestAction, RequestDraft } from '@/lib/api';
import { hour12, localParts, shiftLabel, timeIn } from '@/lib/format';
import { Empty } from '@/components/ui';
import { t } from '@/lib/i18n';

type Session = OwnRecords['sessions'][number];
type Absence = OwnRecords['absences'][number];

interface Target {
  action: RequestAction;
  label: string;
  operationalDate: string;
  timezone: string;
  workSessionId?: string;
  breakId?: string;
  shiftId?: string;
  start: LocalInstant;
  end?: LocalInstant;
}

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));

/**
 * "Mis registros" (kiosco) y "Mis jornadas" (panel), D-70: SOLO la propia ficha, SOLO la ventana de solicitud y
 * datos mínimos. El empleado SOLICITA; su jornada no cambia hasta que alguien con permiso apruebe.
 * `onActivity` permite al kiosco reiniciar su temporizador de inactividad.
 */
export function MyRecords({
  data,
  busy,
  onSubmit,
  onCancelRequest,
  onActivity,
  compact = false,
  branches,
}: {
  data: OwnRecords;
  busy: boolean;
  onSubmit: (draft: RequestDraft) => Promise<boolean>;
  onCancelRequest: (id: string) => Promise<void>;
  onActivity?: () => void;
  compact?: boolean;
  /** Panel: sucursal donde ocurrió una jornada no registrada sin turno (el kiosco usa la suya). */
  branches?: { id: string; name: string }[];
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [reason, setReason] = useState('');
  const [sent, setSent] = useState(false);
  const [branchId, setBranchId] = useState(branches?.[0]?.id ?? '');
  const pendingFor = (key: { workSessionId?: string | null; shiftId?: string | null }) =>
    data.requests.filter((r) => r.status === 'PENDING' && ((key.workSessionId && r.workSessionId === key.workSessionId) || (key.shiftId && r.shiftId === key.shiftId)));

  const choose = (next: Target) => {
    onActivity?.();
    setSent(false);
    setReason('');
    setTarget(next);
  };

  const optionsFor = (s: Session): Target[] => {
    const at = (iso: string) => localParts(iso, s.timezone);
    const base = { operationalDate: s.operationalDate, timezone: s.timezone, workSessionId: s.id };
    const list: Target[] = [
      { ...base, action: 'SET_CLOCK_IN', label: t('req.action.SET_CLOCK_IN'), start: at(s.startedAt) },
      { ...base, action: 'SET_CLOCK_OUT', label: t('req.action.SET_CLOCK_OUT'), start: s.endedAt ? at(s.endedAt) : at(s.startedAt) },
    ];
    for (const b of s.breaks) {
      list.push({ ...base, action: 'SET_BREAK_START', breakId: b.id, label: `${t('req.action.SET_BREAK_START')} (${b.sequence})`, start: at(b.startedAt) });
      list.push({ ...base, action: 'SET_BREAK_END', breakId: b.id, label: `${t('req.action.SET_BREAK_END')} (${b.sequence})`, start: b.endedAt ? at(b.endedAt) : at(b.startedAt) });
    }
    list.push({ ...base, action: 'ADD_BREAK', label: t('req.action.ADD_BREAK'), start: at(s.startedAt), end: at(s.startedAt) });
    return list;
  };

  const absenceTarget = (a: Absence): Target => ({
    action: 'CREATE_SESSION',
    label: t('mine.workedAbsent'),
    operationalDate: a.operationalDate,
    timezone: a.timezone,
    shiftId: a.shiftId,
    start: { date: a.operationalDate, time: a.startTime ?? '09:00' },
    end: { date: a.operationalDate, time: a.endTime ?? '17:00' },
  });

  async function submit() {
    if (!target) return;
    onActivity?.();
    const ok = await onSubmit({
      action: target.action,
      workSessionId: target.workSessionId ?? null,
      breakId: target.breakId ?? null,
      shiftId: target.shiftId ?? null,
      branchId: target.action === 'CREATE_SESSION' && !target.shiftId && branches ? branchId || null : null,
      start: target.start,
      end: target.end ?? null,
      reason: reason.trim(),
    });
    if (ok) {
      setTarget(null);
      setReason('');
      setSent(true);
    }
  }

  const needsEnd = target?.action === 'ADD_BREAK' || target?.action === 'CREATE_SESSION';
  const instantInput = (label: string, value: LocalInstant, onChange: (v: LocalInstant) => void, testid: string) => (
    <fieldset className="instant">
      <legend>{label}</legend>
      <input type="date" aria-label={`${label} · ${t('att.correct.date')}`} value={value.date} min={data.window.from} max={addOne(data.window.to)} onChange={(e) => onChange({ ...value, date: e.target.value })} data-testid={`${testid}-date`} />
      <input type="time" aria-label={`${label} · ${t('att.correct.time')}`} value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value })} data-testid={`${testid}-time`} />
    </fieldset>
  );

  return (
    <div className={`my-records ${compact ? 'compact' : ''}`} onPointerDown={onActivity} onKeyDown={onActivity} onInput={onActivity}>
      <p className="muted">{fill(t('mine.window'), { days: data.window.days, from: data.window.from, to: data.window.to })}</p>
      {sent && <p className="ok" role="status" data-testid="request-sent">{t('mine.form.sent')}</p>}

      {target ? (
        <section className="card request-form" aria-label={t('mine.form.title')}>
          <h2>{target.label} · {target.operationalDate}</h2>
          <p className="muted">{t('mine.form.help')}</p>
          {instantInput(target.action === 'ADD_BREAK' ? t('att.correct.breakStart') : t('mine.form.start'), target.start, (start) => setTarget({ ...target, start }), 'req-start')}
          {needsEnd && target.end && instantInput(target.action === 'ADD_BREAK' ? t('att.correct.breakEnd') : t('mine.form.end'), target.end, (end) => setTarget({ ...target, end }), 'req-end')}
          {target.action === 'CREATE_SESSION' && !target.shiftId && branches && (
            <>
              <label htmlFor="req-branch">{t('common.branch')}</label>
              <select id="req-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </>
          )}
          <label htmlFor="req-reason">{t('mine.form.reason')}</label>
          <textarea id="req-reason" maxLength={500} rows={compact ? 2 : 3} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="row">
            <button type="button" onClick={() => setTarget(null)}>{t('common.cancel')}</button>
            <button type="button" className="primary" disabled={busy || reason.trim().length < 3} onClick={() => void submit()}>{t('mine.form.submit')}</button>
          </div>
        </section>
      ) : (
        <>
          <section>
            <h2>{t('mine.sessions')}</h2>
            {data.sessions.length === 0 && <Empty />}
            <ul className="record-list" data-testid="my-sessions">
              {data.sessions.map((s) => (
                <li key={s.id} className="record">
                  <div>
                    <strong>{s.operationalDate}</strong> · {s.branchName}
                    <div className="muted">
                      {s.shift ? `${t('att.shift')}: ${shiftLabel(s.shift)}` : t('att.noShift')} · {t('att.in')} {timeIn(s.startedAt, s.timezone)} · {t('att.out')} {s.endedAt ? timeIn(s.endedAt, s.timezone) : t('att.open')}
                    </div>
                    {s.breaks.map((b) => (
                      <div key={b.id} className="muted">{t('mine.break')} {b.sequence}: {timeIn(b.startedAt, s.timezone)} – {b.endedAt ? timeIn(b.endedAt, s.timezone) : '…'}</div>
                    ))}
                    {pendingFor({ workSessionId: s.id }).map((r) => <span key={r.id} className="chip open">{t(`req.action.${r.action}`)} · {t('req.status.PENDING')}</span>)}
                  </div>
                  <select aria-label={`${t('mine.request')} ${s.operationalDate}`} value="" disabled={busy} onChange={(e) => { const o = optionsFor(s)[Number(e.target.value)]; if (o) choose(o); }}>
                    <option value="">{t('mine.request')}…</option>
                    {optionsFor(s).map((o, i) => <option key={o.label} value={i}>{o.label}</option>)}
                  </select>
                </li>
              ))}
            </ul>
          </section>

          {data.absences.length > 0 && (
            <section>
              <h2>{t('mine.absences')}</h2>
              <ul className="record-list" data-testid="my-absences">
                {data.absences.map((a) => (
                  <li key={a.shiftId} className="record">
                    <div>
                      <strong>{a.operationalDate}</strong> · {a.branchName}
                      <div className="muted">{a.startTime && a.endTime ? `${hour12(a.startTime)}–${hour12(a.endTime)}${a.crossesMidnight ? ' (+1)' : ''}` : ''} · {t('incident.type.FALTA')}</div>
                    </div>
                    {pendingFor({ shiftId: a.shiftId }).length ? <span className="chip open">{t('req.status.PENDING')}</span> : <button type="button" disabled={busy} onClick={() => choose(absenceTarget(a))}>{t('mine.workedAbsent')}</button>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() =>
              choose({ action: 'CREATE_SESSION', label: t('mine.unregistered'), operationalDate: data.window.to, timezone: '', start: { date: data.window.to, time: '09:00' }, end: { date: data.window.to, time: '17:00' } })
            }
          >
            {t('mine.unregistered')}
          </button>

          <section>
            <h2>{t('mine.requests')}</h2>
            {data.requests.length === 0 && <p className="muted">{t('req.empty')}</p>}
            <ul className="record-list" data-testid="my-requests">
              {data.requests.map((r) => (
                <li key={r.id} className="record">
                  <div>
                    <strong>{t(`req.action.${r.action}`)}</strong> · {r.operationalDate}
                    {r.proposedLocal && (
                      <div className="muted">
                        → {r.proposedLocal.start.date} {r.proposedLocal.start.time}
                        {r.proposedLocal.end ? ` – ${r.proposedLocal.end.date} ${r.proposedLocal.end.time}` : ''}
                      </div>
                    )}
                    {r.decisionReason && <div className="muted">{t('req.decisionReason')}: {r.decisionReason}</div>}
                  </div>
                  <span className={`badge req-${r.status}`}>{t(`req.status.${r.status}`)}</span>
                  {r.status === 'PENDING' && <button type="button" className="link" disabled={busy} onClick={() => { onActivity?.(); void onCancelRequest(r.id); }}>{t('req.cancel')}</button>}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

/** El último día operativo puede terminar al día siguiente (turno nocturno): se permite capturar esa fecha. */
function addOne(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Icon, type IconName } from '@/components/icons';
import { LimitText, StatusBadge } from '@/components/status';
import { Card, Empty, ErrorBox, Field, Loading, OneTimeSecret, useAction, useLoad } from '@/components/ui';
import {
  api, type AuditEntry, type CustomerDetail, type LimitWarning, type Limits, type Plan, type SubscriptionEvent, type SubscriptionResult,
} from '@/lib/api';
import { fmtDate, fmtDateTime, t } from '@/lib/i18n';

type Panel = 'plan' | 'activate' | 'trial' | 'extend' | 'suspend' | 'cancel';
const endOfDay = (d: string) => new Date(`${d}T23:59:59`).toISOString();
const RES: { key: keyof Limits; icon: IconName }[] = [
  { key: 'branches', icon: 'building' }, { key: 'employees', icon: 'users' }, { key: 'kiosks', icon: 'tablet' }, { key: 'members', icon: 'shield' },
];

function eventText(e: SubscriptionEvent): string {
  const base = t(`event.${e.event}`);
  if (e.event === 'PLAN_CHANGED') return `${base}: ${e.fromPlan} → ${e.toPlan}`;
  if (e.event === 'STATUS_CHANGED') return `${base}: ${t(`status.${e.fromStatus}`)} → ${t(`status.${e.toStatus}`)}`;
  if (e.event === 'CREATED') return `${base}: ${e.toPlan} · ${t(`status.${e.toStatus}`)}`;
  return base;
}

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  const detail = useLoad(() => api<CustomerDetail>(`/customers/${id}`), [id]);
  const history = useLoad(() => api<{ events: SubscriptionEvent[]; audit: AuditEntry[] }>(`/customers/${id}/history`), [id]);
  const plans = useLoad(() => api<Plan[]>('/plans'));
  const action = useAction();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [planCode, setPlanCode] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [days, setDays] = useState(14);
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<LimitWarning[]>([]);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);

  const c = detail.data;
  const refresh = async () => { await Promise.all([detail.reload(), history.reload()]); };
  const open = (p: Panel) => { setPanel(panel === p ? null : p); setReason(''); action.setError(null); };

  async function send(path: string, body: unknown, method = 'POST') {
    const res = await action.run(() => api<SubscriptionResult>(`/customers/${id}/subscription/${path}`, { method, body }));
    if (res) { setWarnings(res.warnings ?? []); setPanel(null); await refresh(); }
  }
  const submit = (fn: () => Promise<void>) => (e: FormEvent) => { e.preventDefault(); void fn(); };

  async function resetPassword(email: string) {
    if (!window.confirm(t('detail.resetConfirm'))) return;
    const res = await action.run(() => api<{ email: string; password: string }>('/support/reset-user-password', { method: 'POST', body: { email } }));
    if (res) { setSecret({ label: `${t('detail.newPassword')} · ${res.email}`, value: res.password }); await history.reload(); }
  }

  if (!c) return <><ErrorBox message={detail.error} />{!detail.error && <Loading />}</>;
  const activePlans = plans.data?.filter((p) => p.isActive || p.code === c.planCode) ?? [];
  const end = c.status === 'TRIAL' ? c.trialEndsAt : c.currentPeriodEnd;
  const can = { extend: c.status === 'TRIAL' || c.status === 'ACTIVE', suspend: ['TRIAL', 'ACTIVE', 'EXPIRED'].includes(c.status), cancel: c.status !== 'CANCELLED' };

  return (
    <>
      <div className="hero">
        <div>
          <Link href="/clientes" className="muted">← {t('detail.back')}</Link>
          <h1 data-testid="customer-name">{c.name}</h1>
          <p>{c.slug} · {c.timezone}</p>
        </div>
        <StatusBadge status={c.effectiveStatus} testid="customer-status" />
      </div>
      <ErrorBox message={detail.error ?? action.error} />
      {secret && <OneTimeSecret label={secret.label} value={secret.value} onClose={() => setSecret(null)} />}
      {warnings.length > 0 && (
        <div className="warn-box" role="status" data-testid="limit-warnings">
          <strong><Icon name="alert" size={16} /> {t('detail.warnings')}</strong>
          <ul>{warnings.map((w) => <li key={w.resource}>{t(`res.${w.resource}`)}: {w.used} / {w.limit}</li>)}</ul>
          <p className="muted">{t('detail.warningsHelp')}</p>
        </div>
      )}

      <div className="plan-grid">
        <Card title={t('detail.subscription')} icon="layers">
          <dl className="details">
            <dt>{t('detail.plan')}</dt><dd data-testid="customer-plan">{c.planName}</dd>
            <dt>{t('detail.state')}</dt><dd>{t(`status.${c.status}`)}{c.effectiveStatus !== c.status ? ` (${t(`status.${c.effectiveStatus}`)})` : ''}</dd>
            <dt>{t('detail.validity')}</dt><dd>{c.status === 'TRIAL' || c.status === 'ACTIVE' ? (end ? `${fmtDate(end)}${c.daysLeft !== null ? ` · ${c.daysLeft} ${t('customers.daysLeft')}` : ''}` : t('customers.noValidity')) : '—'}</dd>
            <dt>{t('detail.appState')}</dt><dd data-testid="app-state">{c.organizationStatus === 'ACTIVE' ? t('detail.appActive') : t('detail.appSuspended')}</dd>
            <dt>{t('detail.createdAt')}</dt><dd>{fmtDate(c.createdAt)}</dd>
            <dt>{t('detail.lastActivity')}</dt><dd>{c.lastActivityAt ? fmtDateTime(c.lastActivityAt) : t('detail.noActivity')}</dd>
          </dl>
        </Card>
        <Card title={t('detail.usage')} icon="chart">
          <ul className="usage" data-testid="usage">
            {RES.map(({ key, icon }) => {
              const used = c.usage[key];
              const limit = c.limits[key];
              const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
              return (
                <li key={key}>
                  <div className="usage-row"><span><Icon name={icon} size={16} /> {t(`res.${key}`)}</span><strong><LimitText used={used} limit={limit} /></strong></div>
                  <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={limit ?? undefined} aria-valuenow={used} aria-label={t(`res.${key}`)}>
                    <span className={limit && used > limit ? 'full' : pct >= 80 ? 'near' : ''} style={{ width: `${limit ? pct : 0}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card title={t('detail.actions')} icon="sliders">
        <div className="btn-row" data-testid="actions">
          <button className={panel === 'plan' ? 'primary' : 'secondary'} onClick={() => { open('plan'); setPlanCode(c.planCode); }}>{t('detail.changePlan')}</button>
          <button className={panel === 'activate' ? 'primary' : 'secondary'} onClick={() => { open('activate'); setPlanCode(c.planCode); }}>{t('detail.activate')}</button>
          <button className={panel === 'trial' ? 'primary' : 'secondary'} onClick={() => { open('trial'); setPlanCode(c.planCode); }}>{t('detail.trial')}</button>
          {can.extend && <button className={panel === 'extend' ? 'primary' : 'secondary'} onClick={() => open('extend')}>{t('detail.extend')}</button>}
          {can.suspend && <button className={panel === 'suspend' ? 'danger-solid' : 'danger'} onClick={() => open('suspend')}>{t('detail.suspend')}</button>}
          {can.cancel && <button className={panel === 'cancel' ? 'danger-solid' : 'danger'} onClick={() => open('cancel')}>{t('detail.cancel')}</button>}
        </div>

        {panel === 'plan' && (
          <form className="row panel-form" onSubmit={submit(() => send('change-plan', { planCode }))} data-testid="panel-plan">
            <Field label={t('detail.plan')}><select value={planCode} onChange={(e) => setPlanCode(e.target.value)}>{activePlans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
            <button className="primary" disabled={action.busy || planCode === c.planCode}>{t('detail.changePlanDo')}</button>
          </form>
        )}
        {panel === 'activate' && (
          <form className="row panel-form" onSubmit={submit(() => send('activate', { planCode, currentPeriodEnd: periodEnd ? endOfDay(periodEnd) : null }))} data-testid="panel-activate">
            <Field label={t('detail.plan')}><select value={planCode} onChange={(e) => setPlanCode(e.target.value)}>{activePlans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
            <Field label={t('detail.periodEnd')}><input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></Field>
            <button className="primary" disabled={action.busy}>{t('detail.activateDo')}</button>
            <p className="muted" style={{ width: '100%' }}>{t('detail.activateHelp')}</p>
          </form>
        )}
        {panel === 'trial' && (
          <form className="row panel-form" onSubmit={submit(() => send('start-trial', { days, planCode }))} data-testid="panel-trial">
            <Field label={t('detail.plan')}><select value={planCode} onChange={(e) => setPlanCode(e.target.value)}>{activePlans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
            <Field label={t('detail.days')}><input type="number" min={1} max={90} required value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
            <button className="primary" disabled={action.busy}>{t('detail.trialDo')}</button>
          </form>
        )}
        {panel === 'extend' && (
          <form className="row panel-form" onSubmit={submit(() => send('extend', { until: endOfDay(until) }))} data-testid="panel-extend">
            <Field label={t('detail.until')}><input type="date" required value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
            <button className="primary" disabled={action.busy || !until}>{t('detail.extendDo')}</button>
          </form>
        )}
        {(panel === 'suspend' || panel === 'cancel') && (
          <form className="row panel-form" onSubmit={submit(() => send(panel, { reason }))} data-testid={`panel-${panel}`}>
            <Field label={t('detail.reason')}><input required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <button className="danger-solid" disabled={action.busy || reason.trim().length < 3}>{t('detail.confirm')}</button>
            <p className="muted" style={{ width: '100%' }}>{panel === 'suspend' ? t('detail.suspendHelp') : t('detail.cancelHelp')}</p>
          </form>
        )}
      </Card>

      <div className="plan-grid">
        <Card title={t('detail.admins')} icon="user">
          <table data-testid="admins">
            <tbody>
              {c.admins.map((a) => (
                <tr key={a.email}>
                  <td>{a.displayName}<div className="muted">{a.email}</div></td>
                  <td><button className="secondary" onClick={() => void resetPassword(a.email)}>{t('detail.resetPassword')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title={t('detail.branches')} icon="building">
          <ul className="mini-list">
            {c.branches.map((b) => <li key={b.id}><span>{b.name} <span className="muted">· {b.code}</span></span><span className={`badge ${b.isActive ? 'ok' : 'off'}`}>{b.isActive ? t('common.active') : t('common.inactive')}</span></li>)}
          </ul>
        </Card>
      </div>

      <Card title={t('detail.notes')} icon="scroll">
        <form className="stack" onSubmit={submit(async () => { const r = await action.run(() => api(`/customers/${id}/subscription/notes`, { method: 'PATCH', body: { notes: notes ?? c.notes } })); if (r) { setNotes(null); await refresh(); } })}>
          <textarea rows={3} maxLength={2000} value={notes ?? c.notes} onChange={(e) => setNotes(e.target.value)} aria-label={t('detail.notes')} data-testid="notes" />
          <p className="muted">{t('detail.notesHelp')}</p>
          <div><button className="secondary" disabled={action.busy || notes === null}>{t('detail.notesSave')}</button></div>
        </form>
      </Card>

      <Card title={t('detail.history')} icon="clock">
        {!history.data ? <Loading /> : history.data.events.length === 0 && history.data.audit.length === 0 ? <Empty text={t('detail.historyEmpty')} /> : (
          <ol className="timeline" data-testid="history">
            {history.data.events.map((e) => (
              <li key={`e${e.id}`}><span className="when">{fmtDateTime(e.occurredAt)}</span><span>{eventText(e)}</span><span className="muted">{e.actor}</span></li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}

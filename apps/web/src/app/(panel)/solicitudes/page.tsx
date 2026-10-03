'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useBranches } from '@/components/attendance';
import { Card, ErrorBox, Field, Loading, useAction } from '@/components/ui';
import { api, type CorrectionRequest, type CorrectionRequestDetail, personName } from '@/lib/api';
import { dateTimeIn, shiftLabel, timeIn } from '@/lib/format';
import { errorText, t } from '@/lib/i18n';
import { useLive } from '@/lib/live';

const LIVE_KINDS = ['attendance.request'] as const;

/** Lo solicitado, en la zona de la sucursal donde ocurrió. */
function requested(r: CorrectionRequest, tz: string): string {
  const end = r.proposedEnd ? ` – ${dateTimeIn(r.proposedEnd, tz)}` : '';
  return `${dateTimeIn(r.proposedStart, tz)}${end}`;
}

/** Valor actual del registro que la solicitud quiere cambiar (para comparar antes de decidir). */
function current(d: CorrectionRequestDetail): string {
  const tz = d.timezone;
  const s = d.session;
  if (!s) return d.shift ? `${t('incident.type.FALTA')} · ${t('att.shift')} ${shiftLabel(d.shift)}` : t('att.noShift');
  const brk = s.breaks.find((b) => b.id === d.breakId);
  switch (d.action) {
    case 'SET_CLOCK_IN':
      return `${t('att.in')}: ${dateTimeIn(s.startedAt, tz)}`;
    case 'SET_CLOCK_OUT':
      return `${t('att.out')}: ${s.endedAt ? dateTimeIn(s.endedAt, tz) : t('att.open')}`;
    case 'SET_BREAK_START':
      return brk ? `${t('mine.break')} ${brk.sequence}: ${timeIn(brk.startedAt, tz)}` : '—';
    case 'SET_BREAK_END':
      return brk ? `${t('mine.break')} ${brk.sequence}: ${brk.endedAt ? timeIn(brk.endedAt, tz) : t('att.open')}` : '—';
    case 'ADD_BREAK':
      return s.breaks.length ? s.breaks.map((b) => `${timeIn(b.startedAt, tz)}–${b.endedAt ? timeIn(b.endedAt, tz) : '…'}`).join(', ') : t('common.empty');
    default:
      return '—';
  }
}

/**
 * Bandeja de solicitudes (D-70, D-71). Aprobar aplica EXACTAMENTE lo solicitado (misma lógica y auditoría que una
 * corrección directa); no existe "aprobar con ajuste": si hace falta otro valor, se rechaza y se corrige directo.
 * Nadie decide su propia solicitud (también lo impide PostgreSQL). Se actualiza en vivo.
 */
function RequestsView() {
  const params = useSearchParams();
  const { branches } = useBranches();
  const [filter, setFilter] = useState({ status: params.get('id') ? '' : 'PENDING', branchId: '' });
  const [rows, setRows] = useState<CorrectionRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(params.get('id'));
  const [detail, setDetail] = useState<CorrectionRequestDetail | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const action = useAction();

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (filter.status) q.set('status', filter.status);
    if (filter.branchId) q.set('branchId', filter.branchId);
    try {
      setRows(await api<CorrectionRequest[]>(`/attendance/correction-requests?${q}`));
      setError(null);
    } catch (e) {
      setError(errorText((e as { code?: string }).code));
    }
  }, [filter]);

  const loadDetail = useCallback(async () => {
    if (!selectedId) return setDetail(null);
    try {
      setDetail(await api<CorrectionRequestDetail>(`/attendance/correction-requests/${selectedId}`));
    } catch (e) {
      setDetail(null);
      setError(errorText((e as { code?: string }).code));
    }
  }, [selectedId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setRejectReason('');
    void loadDetail();
  }, [loadDetail]);
  const live = useLive(filter.branchId || undefined, LIVE_KINDS, () => {
    void load();
    void loadDetail();
  });

  async function approve() {
    if (!detail) return;
    const ok = await action.run(() =>
      api(`/attendance/correction-requests/${detail.id}/approve`, { method: 'POST', body: { expectedVersion: detail.version, expectedSessionVersion: detail.session?.version ?? null } }),
    );
    if (ok) await Promise.all([load(), loadDetail()]);
  }
  async function reject() {
    if (!detail) return;
    const ok = await action.run(() => api(`/attendance/correction-requests/${detail.id}/reject`, { method: 'POST', body: { expectedVersion: detail.version, reason: rejectReason } }));
    if (ok) await Promise.all([load(), loadDetail()]);
  }

  return (
    <>
      <h1>{t('req.title')}</h1>
      <div className="row" style={{ marginBottom: '1rem' }}>
        <Field label={t('common.status')}>
          <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
            <option value="">{t('live.all')}</option>
            {(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const).map((s) => <option key={s} value={s}>{t(`req.status.${s}`)}</option>)}
          </select>
        </Field>
        <Field label={t('common.branch')}>
          <select value={filter.branchId} onChange={(e) => setFilter({ ...filter, branchId: e.target.value })}>
            <option value="">{t('live.all')}</option>
            {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <span className={`live-indicator ${live}`} data-status={live}>{live === 'connected' ? t('live.connected') : live === 'polling' ? t('live.polling') : t('live.reconnecting')}</span>
      </div>
      <ErrorBox message={error ?? action.error} />
      <div className="split">
        <Card>
          {!rows ? <Loading /> : rows.length === 0 ? <p className="muted">{t('req.empty')}</p> : (
            <table data-testid="requests">
              <thead><tr><th>{t('incident.date')}</th><th>{t('att.employee')}</th><th>{t('att.correct.action')}</th><th>{t('common.status')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.id === selectedId ? 'selected' : ''} data-testid={`request-${r.id}`}>
                    <td>{r.operationalDate}<div className="muted">{r.branchName}</div></td>
                    <td>{personName(r.employee)}</td>
                    <td><button className="link" onClick={() => setSelectedId(r.id)}>{t(`req.action.${r.action}`)}</button></td>
                    <td><span className={`badge req-${r.status}`}>{t(`req.status.${r.status}`)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        {detail && (
          <Card title={`${t(`req.action.${detail.action}`)} · ${personName(detail.employee)}`}>
            <dl className="details" data-testid="request-detail">
              <dt>{t('common.branch')}</dt><dd>{detail.branchName} · {detail.operationalDate}</dd>
              <dt>{t('req.current')}</dt><dd data-testid="request-current">{current(detail)}</dd>
              <dt>{t('req.requested')}</dt><dd data-testid="request-proposed"><strong>{requested(detail, detail.timezone)}</strong></dd>
              <dt>{t('req.reason')}</dt><dd>{detail.reason}</dd>
              <dt>{t('req.createdAt')}</dt><dd>{dateTimeIn(detail.createdAt, detail.timezone)} · {t(`req.channel.${detail.channel}`)}</dd>
              <dt>{t('common.status')}</dt><dd><span className={`badge req-${detail.status}`}>{t(`req.status.${detail.status}`)}</span></dd>
              {detail.decidedBy && <><dt>{t('req.decidedBy')}</dt><dd>{detail.decidedBy.displayName} · {detail.decidedAt ? dateTimeIn(detail.decidedAt, detail.timezone) : ''}</dd></>}
              {detail.decisionReason && <><dt>{t('req.decisionReason')}</dt><dd>{detail.decisionReason}</dd></>}
              {detail.recorded.length > 0 && <><dt>{t('req.recorded')}</dt><dd>{detail.recorded.map((e) => `${t(`kiosk.action.${e.type}`)} ${timeIn(e.occurredAt, detail.timezone)}`).join(' · ')}</dd></>}
            </dl>
            {detail.session && <p><Link href={`/jornadas/${detail.session.id}`}>{t('att.detail.title')} →</Link></p>}
            {detail.status === 'PENDING' && (detail.canDecide ? (
              <div className="stack">
                <p className="muted">{t('req.approveHelp')}</p>
                <div><button className="primary" disabled={action.busy} onClick={() => void approve()} data-testid="approve">{t('req.approve')}</button></div>
                <div className="row">
                  <Field label={t('req.decisionReason')}><input value={rejectReason} maxLength={500} onChange={(e) => setRejectReason(e.target.value)} /></Field>
                  <button className="danger" disabled={action.busy || !rejectReason.trim()} onClick={() => void reject()} data-testid="reject">{t('req.reject')}</button>
                </div>
              </div>
            ) : <p className="muted">{t('req.cannotDecide')}</p>)}
          </Card>
        )}
      </div>
    </>
  );
}

export default function RequestsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <RequestsView />
    </Suspense>
  );
}

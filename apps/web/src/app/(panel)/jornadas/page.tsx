'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { IncidentChips, shiftDate, useBranches, useOperationalToday } from '@/components/attendance';
import { Card, Empty, ErrorBox, Field, Loading } from '@/components/ui';
import { api, personName, type SessionRow } from '@/lib/api';
import { minutesLabel, shiftLabel, signedMinutes, timeIn } from '@/lib/format';
import { errorText, t } from '@/lib/i18n';

/** Jornadas reales con su turno, entrada/salida efectivas, estado, incidencias y correcciones. */
export default function SessionsPage() {
  const { branches, tzOf } = useBranches();
  // D-78: el rango por defecto parte del día operativo del negocio (lo calcula el servidor)
  const today = useOperationalToday();
  const [filter, setFilter] = useState({ branchId: '', from: '', to: '', status: '', onlyWithIncidents: false });
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (today) setFilter((f) => (f.to ? f : { ...f, from: shiftDate(today, -7), to: today }));
  }, [today]);

  useEffect(() => {
    if (!filter.from || !filter.to) return;
    const q = new URLSearchParams({ from: filter.from, to: filter.to });
    if (filter.branchId) q.set('branchId', filter.branchId);
    if (filter.status) q.set('status', filter.status);
    if (filter.onlyWithIncidents) q.set('onlyWithIncidents', 'true');
    api<SessionRow[]>(`/attendance/sessions?${q}`).then((r) => { setRows(r); setError(null); }, (e) => setError(errorText(e.code)));
  }, [filter]);

  return (
    <>
      <h1>{t('nav.sessions')}</h1>
      <div className="row" style={{ marginBottom: '1rem' }}>
        <Field label={t('common.branch')}>
          <select value={filter.branchId} onChange={(e) => setFilter({ ...filter, branchId: e.target.value })}>
            <option value="">{t('live.all')}</option>
            {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <Field label={t('att.from')}><input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} /></Field>
        <Field label={t('att.to')}><input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} /></Field>
        <Field label={t('common.status')}>
          <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
            <option value="">{t('live.all')}</option>
            {['OPEN', 'REVIEW', 'CLOSED'].map((s) => <option key={s} value={s}>{t(`att.session.status.${s}`)}</option>)}
          </select>
        </Field>
        <label className="row" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={filter.onlyWithIncidents} onChange={(e) => setFilter({ ...filter, onlyWithIncidents: e.target.checked })} />
          {t('att.onlyIncidents')}
        </label>
      </div>
      <ErrorBox message={error} />
      <Card>
        {!rows ? <Loading /> : rows.length === 0 ? <Empty /> : (
          <table>
            <thead>
              <tr>
                <th>{t('live.date')}</th><th>{t('att.employee')}</th><th>{t('common.branch')}</th><th>{t('att.shift')}</th><th>{t('att.in')}</th>
                <th>{t('att.out')}</th><th>{t('att.arrival')}</th><th>{t('att.elapsed')}</th><th>{t('common.status')}</th><th>{t('att.incidents')}</th><th>{t('att.corrections')}</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const tz = tzOf(s.branchId);
                return (
                  <tr key={s.id}>
                    <td>{s.operationalDate}</td>
                    <td>{personName(s.employee)}</td>
                    <td>{s.branchName}</td>
                    <td>{s.shift ? shiftLabel(s.shift) : <span className="muted">{t('att.noShift')}</span>}</td>
                    <td>{timeIn(s.startedAt, tz)}</td>
                    <td>{s.endedAt ? timeIn(s.endedAt, tz) : <span className="muted">{t('att.open')}</span>}</td>
                    <td>{signedMinutes(s.metrics.arrivalDeltaMinutes)}</td>
                    <td>{s.metrics.elapsedMinutes !== null ? minutesLabel(s.metrics.elapsedMinutes) : '—'}</td>
                    <td>{t(`att.session.status.${s.status}`)}</td>
                    <td><IncidentChips incidents={s.incidents} /></td>
                    <td>{s.corrections.count ? `${s.corrections.count} · ${s.corrections.lastBy ?? ''}` : '—'}</td>
                    <td><Link href={`/jornadas/${s.id}`}>{t('att.detail')}</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

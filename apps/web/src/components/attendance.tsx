'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, type Branch, type Incident, type IncidentRef, type SessionRow, type ShiftSummary } from '@/lib/api';
import { shiftLabel, signedMinutes, timeIn } from '@/lib/format';
import { t } from '@/lib/i18n';

/** Sucursales visibles (activas) para los filtros de asistencia. */
export function useBranches() {
  const [branches, setBranches] = useState<Branch[] | null>(null);
  useEffect(() => {
    void api<Branch[]>('/branches').then((list) => setBranches(list.filter((b) => b.isActive)), () => setBranches([]));
  }, []);
  const tzOf = (id: string) => branches?.find((b) => b.id === id)?.effectiveTimezone ?? 'UTC';
  return { branches, tzOf };
}

export const StateBadge = ({ state }: { state: string }) => <span className={`state ${state}`}>{t(`state.${state}`)}</span>;

export function IncidentChips({ incidents }: { incidents: IncidentRef[] }) {
  if (!incidents.length) return <span className="muted">—</span>;
  return (
    <span className="chips">
      {incidents.map((i) => (
        <span key={i.id} className={`chip ${i.status === 'OPEN' ? 'open' : ''}`} title={t(`incident.status.${i.status}`)}>
          {t(`incident.type.${i.type}`)}
        </span>
      ))}
    </span>
  );
}

/** Fecha (YYYY-MM-DD) desplazada N días. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** D-61 · Historial de asistencia de un empleado: PROGRAMADO vs REAL, pausas, incidencias, correcciones y faltas. */
export function AttendanceHistory({ employeeId }: { employeeId: string }) {
  const { tzOf } = useBranches();
  const [range, setRange] = useState({ from: shiftDate(new Date().toISOString().slice(0, 10), -30), to: new Date().toISOString().slice(0, 10) });
  const [data, setData] = useState<{ sessions: SessionRow[]; absences: (Incident & { branchName: string | null; shift: ShiftSummary | null })[] } | null>(null);
  useEffect(() => {
    void api<typeof data>(`/attendance/employees/${employeeId}/history?from=${range.from}&to=${range.to}`).then(setData, () => setData({ sessions: [], absences: [] }));
  }, [employeeId, range]);
  return (
    <section className="card">
      <header className="card-header">
        <h2>{t('history.title')}</h2>
        <div className="row">
          <input type="date" aria-label={t('att.from')} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          <input type="date" aria-label={t('att.to')} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </div>
      </header>
      {!data ? <p className="muted">{t('common.loading')}</p> : (
        <table data-testid="attendance-history">
          <thead>
            <tr>
              <th>{t('live.date')}</th><th>{t('common.branch')}</th><th>{t('att.shift')}</th><th>{t('att.in')}</th><th>{t('att.out')}</th>
              <th>{t('att.arrival')}</th><th>{t('att.breaks')}</th><th>{t('att.breakExcess')}</th><th>{t('att.incidents')}</th><th>{t('att.corrections')}</th><th />
            </tr>
          </thead>
          <tbody>
            {data.sessions.map((s) => {
              const tz = tzOf(s.branchId);
              return (
                <tr key={s.id}>
                  <td>{s.operationalDate}</td><td>{s.branchName}</td>
                  <td>{s.shift ? shiftLabel(s.shift) : <span className="muted">{t('att.noShift')}</span>}</td>
                  <td>{timeIn(s.startedAt, tz)}</td><td>{s.endedAt ? timeIn(s.endedAt, tz) : t('att.open')}</td>
                  <td>{signedMinutes(s.metrics.arrivalDeltaMinutes)}</td>
                  <td>{s.metrics.breakCount ? `${s.metrics.breakMinutes} min` : '—'}</td>
                  <td>{s.metrics.breakExcessMinutes ? `${s.metrics.breakExcessMinutes} min` : '—'}</td>
                  <td><IncidentChips incidents={s.incidents} /></td>
                  <td>{s.corrections.count ? `${s.corrections.count} · ${s.corrections.lastBy ?? ''}` : '—'}</td>
                  <td><Link href={`/jornadas/${s.id}`}>{t('att.detail')}</Link></td>
                </tr>
              );
            })}
            {data.absences.map((a) => (
              <tr key={a.id}>
                <td>{a.operationalDate}</td><td>{a.branchName}</td><td>{a.shift ? shiftLabel(a.shift) : '—'}</td>
                <td colSpan={5}><span className="state MISSED">{t('incident.type.FALTA')}</span></td>
                <td>{t(`incident.status.${a.status}`)}{a.resolution ? ` · ${t(`incident.resolution.${a.resolution}`)}` : ''}</td>
                <td colSpan={2} />
              </tr>
            ))}
            {data.sessions.length === 0 && data.absences.length === 0 && <tr><td colSpan={11} className="muted">{t('common.empty')}</td></tr>}
          </tbody>
        </table>
      )}
    </section>
  );
}

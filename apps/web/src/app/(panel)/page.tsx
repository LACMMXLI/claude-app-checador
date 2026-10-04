'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { StateBadge, shiftDate, useBranches, useOperationalToday } from '@/components/attendance';
import { Icon, type IconName } from '@/components/icons';
import { Card, Empty, ErrorBox, Loading, useLoad } from '@/components/ui';
import { api, type Board, type BoardRow, type Incident, personName, type PersonRef } from '@/lib/api';
import { shiftLabel, timeIn } from '@/lib/format';
import { errorText, t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

interface Dashboard { branches: { total: number; active: number }; employees: { active: number }; members: number | null; kiosks: number | null }
type OpenIncident = Incident & { employee: PersonRef; branchName: string | null };
type Tone = 'green' | 'blue' | 'amber' | 'red' | 'coral';

function Kpi({ tone, icon, label, value, note, href, testid }: { tone: Tone; icon: IconName; label: string; value: number; note?: string; href?: string; testid?: string }) {
  const body = (
    <>
      <div className="kpi-top"><span className="kpi-icon"><Icon name={icon} size={18} /></span>{label}</div>
      <div className="kpi-value" data-testid={testid}>{value}</div>
      {note && <div className="kpi-note">{note}</div>}
    </>
  );
  return href ? <Link href={href} className={`kpi t-${tone}`}>{body}</Link> : <div className={`kpi t-${tone}`}>{body}</div>;
}

const ATTENTION = new Set(['ABSENT_NOT_ARRIVED', 'LATE_NOT_ARRIVED', 'NEEDS_REVIEW', 'MISSED']);

/**
 * Inicio · resumen operativo. Todo sale de la API (tablero de asistencia de cada sucursal visible, incidencias abiertas,
 * solicitudes pendientes); nada se inventa. Sin permiso de asistencia solo se ve el resumen del negocio.
 */
export default function DashboardPage() {
  const { me, can } = useSession();
  const canAttendance = can('attendance.view');
  const approver = can('attendance.correction.apply');
  const { branches } = useBranches();
  const today = useOperationalToday();
  const business = useLoad(() => api<Dashboard>('/dashboard'));
  const pending = useLoad(() => (approver ? api<{ pending: number }>('/attendance/correction-requests/summary') : Promise.resolve({ pending: 0 })), [approver]);
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [incidents, setIncidents] = useState<OpenIncident[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canAttendance || !branches) return;
    let cancelled = false;
    Promise.all(branches.map((b) => api<Board>(`/attendance/board?branchId=${b.id}`))).then(
      (r) => { if (!cancelled) setBoards(r); },
      (e) => { if (!cancelled) { setBoards([]); setError(errorText(e.code)); } },
    );
    return () => { cancelled = true; };
  }, [canAttendance, branches]);

  useEffect(() => {
    if (!canAttendance || !today) return;
    api<OpenIncident[]>(`/attendance/incidents?status=OPEN&from=${shiftDate(today, -30)}&to=${today}`).then(setIncidents, () => setIncidents([]));
  }, [canAttendance, today]);

  const first = (me?.user.displayName ?? '').split(' ')[0];
  const sum = (keys: string[]) => (boards ?? []).reduce((n, b) => n + keys.reduce((m, k) => m + (b.counters[k] ?? 0), 0), 0);
  const rows: { branch: string; tz: string; row: BoardRow }[] = (boards ?? []).flatMap((b) => b.rows.map((row) => ({ branch: b.branch.name, tz: b.branch.timezone, row })));
  rows.sort((a, b) => Number(ATTENTION.has(b.row.state)) - Number(ATTENTION.has(a.row.state)));
  const waiting = pending.data?.pending ?? 0;
  const loadingOps = canAttendance && (!boards || incidents === null);

  return (
    <>
      <div className="hero">
        <div>
          <h1>{t('dashboard.title')}</h1>
          <p>{t('dashboard.greeting')}{first ? `, ${first}` : ''}. {today ? `${t('nav.today')}: ${today}.` : ''}</p>
        </div>
        {/* atajos para ratón/dedo: duplican el menú lateral (que es la navegación accesible) */}
        <div className="quick" aria-hidden="true">
          {canAttendance && <Link href="/asistencia" tabIndex={-1}><Icon name="activity" size={16} />{t('nav.group.attendance')}</Link>}
          {canAttendance && <Link href="/incidencias" tabIndex={-1}><Icon name="alert" size={16} />{t('nav.incidents')}</Link>}
          {can('reports.view') && <Link href="/reportes" tabIndex={-1}><Icon name="chart" size={16} />{t('nav.reports')}</Link>}
          {can('schedules.view') && <Link href="/horario" tabIndex={-1}><Icon name="calendar" size={16} />{t('nav.scheduleShort')}</Link>}
        </div>
      </div>
      <ErrorBox message={error ?? business.error} />

      {canAttendance && (
        <div className="kpis" data-testid="kpis">
          <Kpi tone="green" icon="activity" label={t('dashboard.working')} value={sum(['working', 'onBreak'])} note={t('dashboard.workingNote')} href="/asistencia" testid="kpi-working" />
          <Kpi tone="amber" icon="clock" label={t('dashboard.notArrived')} value={sum(['notArrived'])} note={t('dashboard.notArrivedNote')} href="/asistencia" testid="kpi-not-arrived" />
          <Kpi tone={incidents?.length ? 'red' : 'green'} icon="alert" label={t('dashboard.openIncidents')} value={incidents?.length ?? 0} note={t('dashboard.last30')} href="/incidencias" testid="kpi-incidents" />
          {approver && <Kpi tone={waiting ? 'coral' : 'green'} icon="inbox" label={t('dashboard.pending')} value={waiting} href="/solicitudes" testid="dashboard-pending" />}
        </div>
      )}

      <div className="home-grid">
        {canAttendance ? (
          <Card title={t('dashboard.activity')} icon="activity" actions={<Link href="/asistencia">{t('dashboard.seeLive')}</Link>}>
            {loadingOps ? <Loading /> : rows.length === 0 ? <Empty text={t('dashboard.noShifts')} /> : (
              <table>
                <thead><tr><th>{t('att.employee')}</th><th>{t('common.branch')}</th><th>{t('att.shift')}</th><th>{t('live.state')}</th><th>{t('att.in')}</th></tr></thead>
                <tbody>
                  {rows.slice(0, 8).map(({ branch, tz, row }) => (
                    <tr key={`${row.shift?.id ?? ''}-${row.session?.id ?? row.employee.id}`} className={ATTENTION.has(row.state) ? 'attention' : ''}>
                      <td>{personName(row.employee)}</td>
                      <td>{branch}</td>
                      <td>{row.shift ? shiftLabel(row.shift) : <span className="muted">{t('att.noShift')}</span>}</td>
                      <td><StateBadge state={row.state} /></td>
                      <td>{timeIn(row.session?.startedAt, tz)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {rows.length > 8 && <p className="muted">{t('dashboard.showing')} 8 / {rows.length}</p>}
          </Card>
        ) : (
          <Card title={t('dashboard.business')} icon="building">
            {!business.data ? <Loading /> : <BusinessList data={business.data} />}
          </Card>
        )}
        <div>
          {canAttendance && (
            <Card title={t('dashboard.alerts')} icon="alert">
              {incidents === null ? <Loading /> : incidents.length === 0 ? <Empty text={t('dashboard.noAlerts')} /> : (
                <ul className="mini-list">
                  {incidents.slice(0, 5).map((i) => (
                    <li key={i.id}><span>{personName(i.employee)}</span><span className="flag"><Icon name="alert" size={12} />{t(`incident.type.${i.type}`)}</span></li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          {canAttendance && (
            <Card title={t('dashboard.business')} icon="building">
              {!business.data ? <Loading /> : <BusinessList data={business.data} />}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function BusinessList({ data }: { data: Dashboard }) {
  return (
    <ul className="mini-list">
      <li><span>{t('dashboard.branches')}</span><strong>{data.branches.active}</strong></li>
      <li><span>{t('dashboard.employees')}</span><strong>{data.employees.active}</strong></li>
      {data.members !== null && <li><span>{t('dashboard.members')}</span><strong>{data.members}</strong></li>}
      {data.kiosks !== null && <li><span>{t('dashboard.kiosks')}</span><strong>{data.kiosks}</strong></li>}
    </ul>
  );
}

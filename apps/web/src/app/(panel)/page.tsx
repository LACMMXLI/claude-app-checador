'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useBranches } from '@/components/attendance';
import { Kpi, SparkBars, SparkLine } from '@/components/dashboard';
import { Glyph, Icon } from '@/components/icons';
import { Card, Empty, ErrorBox, Loading, useLoad } from '@/components/ui';
import { api, type Board, type CorrectionRequest, type Incident, type IncidentRef, personName, type PersonRef } from '@/lib/api';
import {
  axisPercent, clock, greetingFor, hourLabel, initials, localParts, minutesOnDay, pendingAt, perDay, perHour, presentAt, presentSeries, shiftDate, timelineAxis, timesOf, toneOf, trend,
  type RowTimes,
} from '@/lib/dashboard';
import { errorText, t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

type IncidentRow = Incident & { employee: PersonRef; branchName: string | null; operationalDate: string };
interface Loaded {
  today: Board[];
  yesterday: Board[];
  incidents: IncidentRow[];
  requests: CorrectionRequest[];
  /** instante del servidor con el que se calculó todo */
  at: Date;
}
interface Dashboard { branches: { total: number; active: number }; employees: { active: number }; members: number | null; kiosks: number | null }

const BRANCH_TONES = ['orange', 'blue', 'violet', 'green', 'teal', 'pink'] as const;
const REFRESH_MS = 60_000;

const longDate = (iso: string) => {
  const s = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** "Hoy 08:12" si ocurrió el día operativo/calendario de hoy; si no, "4 oct 08:12". */
function whenLabel(instant: string, tz: string, todayLocal: string) {
  const { date, minutes } = localParts(instant, tz);
  if (date === todayLocal) return `${t('dashboard.todayWord')} ${clock(minutes)}`;
  const d = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
  return `${d} ${clock(minutes)}`;
}

export default function DashboardPage() {
  const { me, can } = useSession();
  const canAttendance = can('attendance.view');
  const approver = can('attendance.correction.apply');
  const { branches } = useBranches();
  const business = useLoad(() => api<Dashboard>('/dashboard'));
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canAttendance || !branches) return;
    try {
      const today = await Promise.all(branches.map((b) => api<Board>(`/attendance/board?branchId=${b.id}`)));
      const opDate = today[0]?.operationalDate;
      const yDate = opDate ? shiftDate(opDate, -1) : null;
      const [yesterday, incidents, requests] = await Promise.all([
        yDate ? Promise.all(branches.map((b) => api<Board>(`/attendance/board?branchId=${b.id}&date=${yDate}`))) : Promise.resolve([] as Board[]),
        opDate ? api<IncidentRow[]>(`/attendance/incidents?from=${shiftDate(opDate, -30)}&to=${opDate}`) : Promise.resolve([] as IncidentRow[]),
        api<CorrectionRequest[]>('/attendance/correction-requests').catch(() => [] as CorrectionRequest[]),
      ]);
      setData({ today, yesterday, incidents, requests, at: new Date(today[0]?.serverTime ?? Date.now()) });
      setError(null);
    } catch (e) {
      setError(errorText((e as { code?: string }).code));
    }
  }, [canAttendance, branches]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const first = (me?.user.displayName ?? '').split(' ')[0];
  const board0 = data?.today[0];
  const tz0 = board0?.branch.timezone ?? 'UTC';
  const opDate = board0?.operationalDate ?? '';
  const nowMin = data && board0 ? minutesOnDay(data.at, tz0, opDate) : 0;

  return (
    <>
      <h1 className="sr-only">{t('dashboard.title')}</h1>
      <div className="hero">
        <div>
          <div className="greeting" data-testid="greeting">
            {t(`dashboard.greeting.${greetingFor(nowMin || new Date().getHours() * 60)}`)}{first ? `, ${first}` : ''}
          </div>
          <p className="hero-sub">
            {opDate ? longDate(opDate) : ''}
            {board0 && <><span className="sep" aria-hidden="true">|</span>{board0.isToday ? t('dashboard.inProgress') : t('dashboard.pastDay')}</>}
          </p>
        </div>
        <div className="quick" aria-hidden="true">
          {canAttendance && <Link href="/asistencia" tabIndex={-1} className="primary-pill"><Glyph name="users" size={20} />{t('nav.group.attendance')}</Link>}
          {canAttendance && <Link href="/incidencias" tabIndex={-1}><Glyph name="alert" size={20} />{t('nav.incidents')}</Link>}
          {can('reports.view') && <Link href="/reportes" tabIndex={-1}><Glyph name="chart" size={20} />{t('nav.reports')}</Link>}
          {can('schedules.view') && <Link href="/horario" tabIndex={-1}><Icon name="clock" size={20} />{t('nav.scheduleShort')}</Link>}
        </div>
      </div>
      <ErrorBox message={error ?? business.error} />
      {canAttendance ? (data ? <Operational data={data} nowMin={nowMin} opDate={opDate} approver={approver} /> : <Loading />) : (
        <Card title={t('dashboard.business')} icon="building">{!business.data ? <Loading /> : <BusinessList data={business.data} />}</Card>
      )}
    </>
  );
}

function Operational({ data, nowMin, opDate, approver }: { data: Loaded; nowMin: number; opDate: string; approver: boolean }) {
  const { today, yesterday, incidents, requests } = data;
  const tz0 = today[0]?.branch.timezone ?? 'UTC';
  const todayLocal = localParts(data.at, tz0).date;
  const yLocal = shiftDate(todayLocal, -1);

  // ── tiempos por sucursal (hoy y ayer) ────────────────────────────────────────
  const todayTimes: RowTimes[][] = today.map(timesOf);
  const yTimes: RowTimes[][] = yesterday.map(timesOf);
  const all = todayTimes.flat();
  const yAll = yTimes.flat();

  const present = presentAt(all, nowMin);
  const presentY = presentAt(yAll, nowMin);
  const waiting = pendingAt(all, nowMin);
  const waitingY = pendingAt(yAll, nowMin);

  const firstHour = Math.max(0, Math.floor(Math.min(...all.flatMap((r) => [r.in, r.shiftStart]).filter((v): v is number => v !== null), nowMin) / 60));
  const lastHour = Math.floor(nowMin / 60);
  const presentLine = presentSeries(all, firstHour, lastHour, nowMin);
  const startsByHour = perHour(all.flatMap((r) => (r.shiftStart !== null ? [r.shiftStart] : [])), Math.min(firstHour, 6), Math.max(lastHour + 6, 18)).slice(0);

  // ── incidencias y solicitudes ─────────────────────────────────────────────────
  const open = incidents.filter((i) => i.status === 'OPEN');
  const incDays = perDay(incidents.map((i) => i.operationalDate), opDate, 7);
  const reqDates = requests.map((r) => localParts(r.createdAt, tz0).date);
  const reqDays = perDay(reqDates, todayLocal, 7);
  const pendingRequests = requests.filter((r) => r.status === 'PENDING');
  const newInc = incDays[6]!;
  const newIncY = incDays[5]!;
  const newReq = reqDays[6]!;
  const newReqY = reqDays[5]!;

  // ── "Requiere atención": incidencias abiertas y solicitudes pendientes, lo más reciente primero ──
  const attention = [
    ...open.map((i) => ({ key: `i-${i.id}`, person: i.employee, branch: i.branchName, label: t(`incident.type.${i.type}`), tone: i.type === 'FALTA' || i.type === 'SALIDA_OLVIDADA' ? 'red' : 'amber', at: i.detectedAt, href: '/incidencias' })),
    ...(approver ? pendingRequests.map((r) => ({ key: `r-${r.id}`, person: r.employee, branch: r.branchName, label: t('dashboard.correctionRequest'), tone: 'yellow', at: r.createdAt, href: `/solicitudes?id=${r.id}` })) : []),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <>
      <div className="kpis" data-testid="kpis">
        <Kpi tone="green" glyph="users" label={t('dashboard.working')} value={present} href="/asistencia" testid="kpi-working"
          delta={yesterday.length ? trend(present, presentY).delta : null} deltaGood deltaText={t('dashboard.vsYesterday')} note={t('dashboard.workingNote')}
          chart={<SparkLine values={presentLine} label={t('dashboard.chart.present')} />} />
        <Kpi tone="blue" glyph="clock" label={t('dashboard.notArrived')} value={waiting} href="/asistencia" testid="kpi-not-arrived"
          delta={yesterday.length ? trend(waiting, waitingY).delta : null} deltaGood={false} deltaText={t('dashboard.vsYesterday')} note={t('dashboard.notArrivedNote')}
          chart={<SparkBars values={startsByHour} label={t('dashboard.chart.starts')} />} />
        <Kpi tone="red" glyph="alert" label={t('dashboard.openIncidents')} value={open.length} href="/incidencias" testid="kpi-incidents"
          delta={trend(newInc, newIncY).delta} deltaGood={false} deltaText={t('dashboard.newVsYesterday')} note=""
          chart={<SparkLine values={incDays} label={t('dashboard.chart.incidents')} />} />
        {approver && (
          <Kpi tone="orange" glyph="document" label={t('dashboard.pending')} value={pendingRequests.length} href="/solicitudes" testid="dashboard-pending"
            delta={trend(newReq, newReqY).delta} deltaGood={false} deltaText={t('dashboard.newVsYesterday')} note=""
            chart={<SparkBars values={reqDays} label={t('dashboard.chart.requests')} />} />
        )}
      </div>

      <div className="home-grid">
        <Timeline today={today} times={todayTimes} nowMin={nowMin} tz={tz0} />
        <div className="side-col">
          <Attention items={attention} tz={tz0} todayLocal={todayLocal} yLocal={yLocal} />
          <Branches today={today} times={todayTimes} nowMin={nowMin} />
        </div>
      </div>
    </>
  );
}

function Timeline({ today, times, nowMin, tz }: { today: Board[]; times: RowTimes[][]; nowMin: number; tz: string }) {
  const marks = times.flat().flatMap((r) => [r.shiftStart, r.shiftEnd, r.in, r.out]).filter((v): v is number => v !== null);
  if (today.length === 0) return <Card title={t('dashboard.activity')} icon="activity"><Empty text={t('dashboard.noShifts')} /></Card>;
  const axis = timelineAxis(marks, nowMin);
  const pct = (m: number) => `${axisPercent(axis, m).toFixed(2)}%`;
  const nowPct = axisPercent(axis, nowMin);
  return (
    <section className="panel-card timeline-card" data-testid="timeline">
      <header className="panel-head">
        <span className="panel-icon"><Icon name="clock" size={30} /></span>
        <div>
          <h2>{t('dashboard.activity')}</h2>
          <p>{t('dashboard.activitySub')}</p>
        </div>
        <Link href="/asistencia" className="pill-link">{t('dashboard.seeDetail')} <Glyph name="arrowRight" size={16} /></Link>
      </header>
      <div className="tl-scroll" tabIndex={0} aria-label={t('dashboard.activity')}>
        <div className="tl">
          <div className="tl-axis" aria-hidden="true">
            {axis.ticks.map((m) => <span key={m} style={{ left: pct(m) }}>{hourLabel(m)}</span>)}
          </div>
          {today.map((b, i) => {
            const tm = times[i]!;
            const tone = BRANCH_TONES[i % BRANCH_TONES.length]!;
            const starts = tm.flatMap((r) => (r.shiftStart !== null ? [r.shiftStart] : []));
            const ends = tm.flatMap((r) => (r.shiftEnd !== null ? [r.shiftEnd] : []));
            const scheduled = b.counters.scheduled ?? 0;
            const onShift = presentAt(tm, nowMin);
            const entries = b.rows.filter((_, k) => tm[k]!.in !== null && tm[k]!.in! <= nowMin).length;
            const exits = tm.filter((r) => r.out !== null && r.out <= nowMin).length;
            const waiting = tm.filter((r) => r.shiftStart !== null && r.shiftStart <= nowMin && !(r.in !== null && r.in <= nowMin)).length;
            return (
              <div className={`tl-row b-${tone}`} key={b.branch.id} data-testid={`tl-row-${b.branch.name}`}>
                <div className="tl-name">
                  <span className="dot" />
                  <div><strong>{b.branch.name}</strong><span>{onShift} {t('dashboard.of')} {scheduled} {t('dashboard.onShift')}</span></div>
                </div>
                <div className="tl-track" role="img" aria-label={`${b.branch.name}: ${entries} ${t('dashboard.legend.in').toLowerCase()}, ${exits} ${t('dashboard.legend.out').toLowerCase()}, ${waiting} ${t('dashboard.legend.waiting').toLowerCase()}`}>
                  {axis.ticks.map((m) => <i key={m} className="grid-line" style={{ left: pct(m) }} />)}
                  {starts.length > 0 && <span className="tl-bar" style={{ left: pct(Math.min(...starts)), width: `${axisPercent(axis, Math.max(...ends)) - axisPercent(axis, Math.min(...starts))}%` }} />}
                  {tm.map((r, k) => {
                    const who = personName(b.rows[k]!.employee);
                    return (
                      <span key={k}>
                        {r.in !== null && r.in <= nowMin && <i className="ev in" style={{ left: pct(r.in) }} title={`${who} · ${t('dashboard.legend.in')} ${clock(r.in)}`} />}
                        {r.out !== null && r.out <= nowMin && <i className="ev out" style={{ left: pct(r.out) }} title={`${who} · ${t('dashboard.legend.out')} ${clock(r.out)}`} />}
                        {r.shiftStart !== null && !(r.in !== null && r.in <= nowMin) && <i className="ev wait" style={{ left: pct(r.shiftStart) }} title={`${who} · ${t('dashboard.scheduledAt')} ${clock(r.shiftStart)}`} />}
                      </span>
                    );
                  })}
                  {nowPct >= 0 && nowPct <= 100 && <i className="tl-now" style={{ left: `${nowPct}%` }} />}
                </div>
              </div>
            );
          })}
          <div className="tl-now-label" style={{ left: `calc(var(--tl-name) + (100% - var(--tl-name)) * ${(nowPct / 100).toFixed(4)})` }} data-testid="tl-now">
            <b>{clock(nowMin)}</b>
            <span>{t('dashboard.nowLabel')}</span>
          </div>
        </div>
      </div>
      <ul className="tl-legend" aria-label={t('dashboard.legend')}>
        <li><i className="ev in" />{t('dashboard.legend.in')}</li>
        <li><i className="ev out" />{t('dashboard.legend.out')}</li>
        <li><i className="ev wait" />{t('dashboard.legend.waiting')}</li>
        <li><i className="ev bar" />{t('dashboard.legend.shift')}</li>
        <li className="muted">{tz.replace('_', ' ')}</li>
      </ul>
    </section>
  );
}

function Attention({ items, tz, todayLocal, yLocal }: { items: { key: string; person: PersonRef; branch: string | null; label: string; tone: string; at: string; href: string }[]; tz: string; todayLocal: string; yLocal: string }) {
  void yLocal;
  return (
    <section className="panel-card attention" data-testid="attention">
      <header className="panel-head">
        <span className="panel-icon red"><Glyph name="alert" size={30} /></span>
        <div><h2>{t('dashboard.alerts')}</h2><p>{t('dashboard.alertsSub')}</p></div>
      </header>
      {items.length === 0 ? <Empty text={t('dashboard.noAlerts')} /> : (
        <ul className="att-list">
          {items.slice(0, 4).map((it) => {
            const name = personName(it.person);
            return (
              <li key={it.key}>
                <Link href={it.href} className="att-item">
                  <span className={`avatar-sm tone-${toneOf(name)}`} aria-hidden="true">{initials(name)}</span>
                  <span className="att-who"><strong>{name}</strong><span>{it.branch ?? '—'}</span></span>
                  <span className={`att-tag ${it.tone}`}>{it.label}</span>
                  <span className="att-when">{whenLabel(it.at, tz, todayLocal)}</span>
                  <Glyph name="chevronRight" size={16} className="att-go" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {items.length > 4 && <p className="muted att-more">+{items.length - 4} {t('dashboard.moreItems')}</p>}
    </section>
  );
}

function Branches({ today, times, nowMin }: { today: Board[]; times: RowTimes[][]; nowMin: number }) {
  return (
    <section className="panel-card" data-testid="branches-card">
      <header className="panel-head">
        <span className="panel-icon"><Glyph name="store" size={30} /></span>
        <div><h2>{t('dashboard.business')}</h2><p>{today.length} {today.length === 1 ? t('dashboard.branchActive') : t('dashboard.branchesActive')}</p></div>
        <Link href="/sucursales" className="pill-link">{t('dashboard.seeBranches')} <Glyph name="arrowRight" size={16} /></Link>
      </header>
      <div className="branch-cards">
        {today.map((b, i) => {
          const tone = BRANCH_TONES[i % BRANCH_TONES.length]!;
          const scheduled = b.counters.scheduled ?? 0;
          const here = presentAt(times[i]!, nowMin);
          const pct = scheduled ? Math.min(100, Math.round((here / scheduled) * 100)) : 0;
          return (
            <div className={`branch-card b-${tone}`} key={b.branch.id}>
              <div className="bc-head"><Glyph name="store" size={28} /><div><strong>{b.branch.name}</strong><span className={here > 0 ? 'on' : 'off'}>{here > 0 ? t('dashboard.operating') : t('dashboard.noOne')}</span></div></div>
              <div className="bc-count"><b>{here}</b> {t('dashboard.of')} {scheduled} {t('dashboard.presentWord')}</div>
              <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={scheduled} aria-valuenow={here} aria-label={`${b.branch.name}: ${t('dashboard.presentWord')}`}><span style={{ width: `${pct}%` }} /></div>
            </div>
          );
        })}
      </div>
    </section>
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

export type { IncidentRef };

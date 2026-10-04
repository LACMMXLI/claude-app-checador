'use client';

import Link from 'next/link';
import { Icon, type IconName } from '@/components/icons';
import { ErrorBox, Loading, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

interface Dashboard { branches: { total: number; active: number }; employees: { active: number }; members: number | null; kiosks: number | null }

type Tone = 'orange' | 'blue' | 'green' | 'violet' | 'teal' | 'red';

function Stat({ tone, icon, label, value, testid }: { tone: Tone; icon: IconName; label: string; value: number; testid?: string }) {
  return (
    <div className={`stat-card t-${tone}`}>
      <span className="stat-icon"><Icon name={icon} size={22} /></span>
      <div className="label">{label}</div>
      <div className="stat" data-testid={testid}>{value}</div>
    </div>
  );
}

function Shortcut({ href, tone, icon, title, text }: { href: string; tone: Tone; icon: IconName; title: string; text: string }) {
  return (
    // Duplican las opciones del menú lateral (que es la navegación accesible): atajo solo para el ratón/dedo
    <Link href={href} className={`shortcut t-${tone}`} aria-hidden="true" tabIndex={-1}>
      <span className="stat-icon"><Icon name={icon} size={20} /></span>
      <span><strong>{title}</strong><small>{text}</small></span>
    </Link>
  );
}

export default function DashboardPage() {
  const { data, error } = useLoad(() => api<Dashboard>('/dashboard'));
  const { me, can } = useSession();
  const approver = can('attendance.correction.apply');
  const pending = useLoad(() => (approver ? api<{ pending: number }>('/attendance/correction-requests/summary') : Promise.resolve({ pending: 0 })), [approver]);
  const first = (me?.user.displayName ?? '').split(' ')[0];
  const waiting = pending.data?.pending ?? 0;
  return (
    <>
      <div className="hero">
        <div>
          <h1>{t('dashboard.title')}</h1>
          <p>{t('dashboard.greeting')}{first ? `, ${first}` : ''}. {t('dashboard.today')}.</p>
        </div>
        {approver && (
          <Link href="/solicitudes" className={`live-indicator ${waiting ? 'reconnecting' : 'connected'}`} style={{ color: waiting ? 'var(--warn)' : 'var(--ok)' }}>
            <Icon name={waiting ? 'inbox' : 'sparkles'} size={16} /> {waiting ? `${waiting} ${t('req.pendingBadge')}` : t('dashboard.allClear')}
          </Link>
        )}
      </div>
      <ErrorBox message={error} />
      {!data ? <Loading /> : (
        <div className="grid">
          <Stat tone="orange" icon="building" label={t('dashboard.branches')} value={data.branches.active} />
          <Stat tone="blue" icon="users" label={t('dashboard.employees')} value={data.employees.active} />
          {data.members !== null && <Stat tone="violet" icon="shield" label={t('dashboard.members')} value={data.members} />}
          {data.kiosks !== null && <Stat tone="teal" icon="tablet" label={t('dashboard.kiosks')} value={data.kiosks} />}
          {approver && <Stat tone={waiting ? 'red' : 'green'} icon="inbox" label={t('dashboard.pending')} value={waiting} testid="dashboard-pending" />}
        </div>
      )}
      <div className="section-title">{t('dashboard.shortcuts')}</div>
      <div className="shortcuts">
        {can('attendance.view') && <Shortcut href="/asistencia" tone="green" icon="activity" title={t('nav.live')} text={t('dashboard.sc.live')} />}
        {can('reports.view') && <Shortcut href="/reportes" tone="blue" icon="chart" title={t('nav.reports')} text={t('dashboard.sc.reports')} />}
        {can('schedules.view') && <Shortcut href="/horario" tone="orange" icon="calendar" title={t('nav.schedule')} text={t('dashboard.sc.schedule')} />}
        {can('employees.view') && <Shortcut href="/empleados" tone="violet" icon="users" title={t('nav.employees')} text={t('dashboard.sc.employees')} />}
        {can('attendance.view') && <Shortcut href="/incidencias" tone="red" icon="alert" title={t('nav.incidents')} text={t('dashboard.sc.incidents')} />}
        {can('kiosks.manage') && <Shortcut href="/kioscos" tone="teal" icon="tablet" title={t('nav.kiosks')} text={t('dashboard.sc.kiosks')} />}
      </div>
    </>
  );
}

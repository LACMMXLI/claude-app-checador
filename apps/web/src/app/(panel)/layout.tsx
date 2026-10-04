'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { Icon, type IconName } from '@/components/icons';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

const NAV: readonly { href: string; label: string; permission: string | null; icon: IconName }[] = [
  { href: '/', label: 'nav.dashboard', permission: null, icon: 'home' },
  { href: '/asistencia', label: 'nav.live', permission: 'attendance.view', icon: 'activity' },
  { href: '/jornadas', label: 'nav.sessions', permission: 'attendance.view', icon: 'clock' },
  { href: '/incidencias', label: 'nav.incidents', permission: 'attendance.view', icon: 'alert' },
  { href: '/solicitudes', label: 'nav.requests', permission: 'attendance.view', icon: 'inbox' },
  { href: '/reportes', label: 'nav.reports', permission: 'reports.view', icon: 'chart' },
  { href: '/horario', label: 'nav.schedule', permission: 'schedules.view', icon: 'calendar' },
  { href: '/plantillas', label: 'nav.templates', permission: 'schedules.templates.manage', icon: 'layers' },
  { href: '/sucursales', label: 'nav.branches', permission: null, icon: 'building' },
  { href: '/empleados', label: 'nav.employees', permission: 'employees.view', icon: 'users' },
  { href: '/usuarios', label: 'nav.users', permission: 'memberships.manage', icon: 'shield' },
  { href: '/kioscos', label: 'nav.kiosks', permission: 'kiosks.manage', icon: 'tablet' },
  { href: '/politicas', label: 'nav.policies', permission: 'settings.manage', icon: 'sliders' },
  { href: '/auditoria', label: 'nav.audit', permission: 'audit.view', icon: 'scroll' },
];

/** Las opciones se ocultan según permisos SOLO por comodidad: la autorización real la hace el backend. */
export default function PanelLayout({ children }: { children: ReactNode }) {
  const { me, can } = useSession();
  const pathname = usePathname();
  const [pending, setPending] = useState(0);
  const [open, setOpen] = useState(false);
  const approver = can('attendance.correction.apply');

  // solicitudes pendientes que el usuario puede decidir (se refresca al navegar)
  useEffect(() => {
    if (!approver) return;
    void api<{ pending: number }>('/attendance/correction-requests/summary').then((r) => setPending(r.pending), () => setPending(0));
  }, [approver, pathname]);
  // el menú móvil se cierra al navegar
  useEffect(() => setOpen(false), [pathname]);

  if (!me?.activeOrganization) return null;
  const nav = [
    ...NAV.filter((n) => !n.permission || can(n.permission)),
    ...(me.employeeId ? [{ href: '/mis-jornadas', label: 'nav.mySessions', permission: null, icon: 'userCheck' as IconName }] : []),
  ];
  const initial = (me.user.displayName || me.user.email).trim().charAt(0).toUpperCase();

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/login');
  }

  const active = (href: string) => pathname === href || (href !== '/' && pathname.startsWith(href));

  return (
    <div className={`shell ${open ? 'open' : ''}`}>
      <nav className="sidebar" aria-label="Principal">
        <div className="brand">
          <span className="brand-mark"><Icon name="clock" size={22} /></span>
          <div>
            <div className="org">{me.activeOrganization.name}</div>
            <small>{t('login.heroTitle')}</small>
          </div>
        </div>
        {nav.map((n) => (
          <Link key={n.href} href={n.href} className={active(n.href) ? 'active' : ''} aria-current={active(n.href) ? 'page' : undefined}>
            <Icon name={n.icon} />
            {t(n.label)}
            {n.href === '/solicitudes' && pending > 0 && <span className="nav-badge" data-testid="pending-badge" aria-label={`${pending} ${t('req.pendingBadge')}`}>{pending}</span>}
          </Link>
        ))}
        <div className="bottom">
          <Link href="/cuenta" className={active('/cuenta') ? 'active' : ''}><Icon name="user" />{t('nav.account')}</Link>
          {me.memberships.length > 1 && <Link href="/seleccionar-negocio"><Icon name="swap" />{t('nav.switchOrg')}</Link>}
          <button className="link" onClick={() => void logout()}><Icon name="logout" />{t('nav.logout')}</button>
        </div>
      </nav>
      <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <div className="content">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label={open ? t('nav.closeMenu') : t('nav.menu')} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <Icon name={open ? 'close' : 'menu'} size={22} />
          </button>
          <span className="spacer" />
          {approver && (
            <Link href="/solicitudes" className={`bell ${pending > 0 ? 'ring' : ''}`} title={t('nav.notifications')} aria-label={`${t('nav.notifications')}: ${pending} ${t('req.pendingBadge')}`}>
              <Icon name="bell" size={20} />
              {pending > 0 && <span className="nav-badge">{pending}</span>}
            </Link>
          )}
          <span className="who"><strong>{me.user.displayName}</strong><span>{me.user.email}</span></span>
          <Link href="/cuenta" className="avatar" title={t('nav.account')} aria-hidden="true" tabIndex={-1}>{initial}</Link>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}

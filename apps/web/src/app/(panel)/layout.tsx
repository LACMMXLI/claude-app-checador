'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

const NAV = [
  { href: '/', label: 'nav.dashboard', permission: null },
  { href: '/asistencia', label: 'nav.live', permission: 'attendance.view' },
  { href: '/jornadas', label: 'nav.sessions', permission: 'attendance.view' },
  { href: '/incidencias', label: 'nav.incidents', permission: 'attendance.view' },
  { href: '/solicitudes', label: 'nav.requests', permission: 'attendance.view' },
  { href: '/reportes', label: 'nav.reports', permission: 'reports.view' },
  { href: '/horario', label: 'nav.schedule', permission: 'schedules.view' },
  { href: '/plantillas', label: 'nav.templates', permission: 'schedules.templates.manage' },
  { href: '/sucursales', label: 'nav.branches', permission: null },
  { href: '/empleados', label: 'nav.employees', permission: 'employees.view' },
  { href: '/usuarios', label: 'nav.users', permission: 'memberships.manage' },
  { href: '/kioscos', label: 'nav.kiosks', permission: 'kiosks.manage' },
  { href: '/politicas', label: 'nav.policies', permission: 'settings.manage' },
  { href: '/auditoria', label: 'nav.audit', permission: 'audit.view' },
] as const;

/** Las opciones se ocultan según permisos SOLO por comodidad: la autorización real la hace el backend. */
export default function PanelLayout({ children }: { children: ReactNode }) {
  const { me, can } = useSession();
  const pathname = usePathname();
  const [pending, setPending] = useState(0);
  const approver = can('attendance.correction.apply');
  // solicitudes pendientes que el usuario puede decidir (se refresca al navegar)
  useEffect(() => {
    if (!approver) return;
    void api<{ pending: number }>('/attendance/correction-requests/summary').then((r) => setPending(r.pending), () => setPending(0));
  }, [approver, pathname]);
  if (!me?.activeOrganization) return null;
  const nav = [
    ...NAV.filter((n) => !n.permission || can(n.permission)),
    ...(me.employeeId ? [{ href: '/mis-jornadas', label: 'nav.mySessions', permission: null }] : []),
  ];

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/login');
  }

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="org">{me.activeOrganization.name}</div>
        {nav.map((n) => (
          <Link key={n.href} href={n.href} className={pathname === n.href || (n.href !== '/' && pathname.startsWith(n.href)) ? 'active' : ''}>
            {t(n.label)}
            {n.href === '/solicitudes' && pending > 0 && <span className="nav-badge" data-testid="pending-badge" aria-label={`${pending} ${t('req.pendingBadge')}`}>{pending}</span>}
          </Link>
        ))}
        <div className="bottom">
          <span className="muted">{me.user.displayName}</span>
          {me.memberships.length > 1 && <Link href="/seleccionar-negocio">{t('nav.switchOrg')}</Link>}
          <button className="link" onClick={() => void logout()}>{t('nav.logout')}</button>
        </div>
      </nav>
      <main>{children}</main>
    </div>
  );
}

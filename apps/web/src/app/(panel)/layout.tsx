'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

const NAV = [
  { href: '/', label: 'nav.dashboard', permission: null },
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
  if (!me?.activeOrganization) return null;

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/login');
  }

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="org">{me.activeOrganization.name}</div>
        {NAV.filter((n) => !n.permission || can(n.permission)).map((n) => (
          <Link key={n.href} href={n.href} className={pathname === n.href || (n.href !== '/' && pathname.startsWith(n.href)) ? 'active' : ''}>
            {t(n.label)}
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

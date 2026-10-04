'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { useOperationalToday } from '@/components/attendance';
import { Icon, type IconName } from '@/components/icons';
import { SectionTabs } from '@/components/section-tabs';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { NAV_GROUPS, tabActive } from '@/lib/nav';
import { useSession } from '@/lib/session';

/** Las opciones se ocultan según permisos SOLO por comodidad: la autorización real la hace el backend. */
export default function PanelLayout({ children }: { children: ReactNode }) {
  const { me, can } = useSession();
  const pathname = usePathname();
  const [pending, setPending] = useState(0);
  const [open, setOpen] = useState(false);
  const approver = can('attendance.correction.apply');
  const today = useOperationalToday();

  // solicitudes pendientes que el usuario puede decidir (se refresca al navegar)
  useEffect(() => {
    if (!approver) return;
    void api<{ pending: number }>('/attendance/correction-requests/summary').then((r) => setPending(r.pending), () => setPending(0));
  }, [approver, pathname]);
  // el menú móvil se cierra al navegar
  useEffect(() => setOpen(false), [pathname]);

  if (!me?.activeOrganization) return null;
  const groups = NAV_GROUPS.map((g) => ({ ...g, visible: g.tabs.filter((x) => !x.permission || can(x.permission)) })).filter((g) => g.visible.length > 0);
  const mine = me.employeeId ? { href: '/mis-jornadas', label: 'nav.mySessions', icon: 'userCheck' as IconName } : null;
  const initial = (me.user.displayName || me.user.email).trim().charAt(0).toUpperCase();

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/login');
  }

  const groupActive = (g: (typeof groups)[number]) => g.tabs.some((x) => tabActive(pathname, x.href));

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
        {groups.map((g) => (
          <Link key={g.key} href={g.visible[0]!.href} className={groupActive(g) ? 'active' : ''} aria-current={groupActive(g) ? 'page' : undefined}>
            <Icon name={g.icon} />
            {t(g.label)}
            {g.key === 'operation' && pending > 0 && <span className="nav-badge" data-testid="pending-badge" aria-label={`${pending} ${t('req.pendingBadge')}`}>{pending}</span>}
          </Link>
        ))}
        {mine && (
          <Link href={mine.href} className={tabActive(pathname, mine.href) ? 'active' : ''} aria-current={tabActive(pathname, mine.href) ? 'page' : undefined}>
            <Icon name={mine.icon} />{t(mine.label)}
          </Link>
        )}
        <div className="bottom">
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
          <div className="context" data-testid="context">
            <strong>{me.activeOrganization.name}</strong>
            {today && <span><Icon name="calendar" size={14} /> {t('nav.today')}: {today}</span>}
          </div>
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
        <main><SectionTabs pending={pending} />{children}</main>
      </div>
    </div>
  );
}

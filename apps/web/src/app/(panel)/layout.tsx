'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useOperationalToday } from '@/components/attendance';
import { Glyph, Icon, type IconName } from '@/components/icons';
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
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const approver = can('attendance.correction.apply');
  const today = useOperationalToday();

  // solicitudes pendientes que el usuario puede decidir (se refresca al navegar)
  useEffect(() => {
    if (!approver) return;
    void api<{ pending: number }>('/attendance/correction-requests/summary').then((r) => setPending(r.pending), () => setPending(0));
  }, [approver, pathname]);
  // el menú móvil y el menú de la persona se cierran al navegar
  useEffect(() => { setOpen(false); setMenu(false); }, [pathname]);
  // el menú de la persona se cierra con Escape o al hacer clic fuera
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    const onClick = (e: MouseEvent) => menuRef.current && !menuRef.current.contains(e.target as Node) && setMenu(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onClick); };
  }, [menu]);

  if (!me?.activeOrganization) return null;
  const org = me.activeOrganization;
  const groups = NAV_GROUPS.map((g) => ({ ...g, visible: g.tabs.filter((x) => !x.permission || can(x.permission)) })).filter((g) => g.visible.length > 0);
  const mine = me.employeeId ? { href: '/mis-jornadas', label: 'nav.mySessions', icon: 'userCheck' as IconName } : null;
  const initial = (me.user.displayName || me.user.email).trim().charAt(0).toUpperCase();
  const groupActive = (g: (typeof groups)[number]) => g.tabs.some((x) => tabActive(pathname, x.href));

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/login');
  }

  return (
    <div className={`shell ${open ? 'open' : ''}`}>
      <nav className="sidebar" aria-label="Principal">
        <div className="brand">
          {org.branding.logoUrl ? (
            // La imagen de marca la define cada negocio (branding); el nombre queda como texto para lectores de pantalla
            <>
              <img src={org.branding.logoUrl} alt="" className="brand-logo" />
              <span className="org sr-only">{org.name}</span>
            </>
          ) : (
            <>
              <span className="brand-mark"><Icon name="clock" size={22} /></span>
              <div>
                <div className="org">{org.name}</div>
                <small>{t('login.heroTitle')}</small>
              </div>
            </>
          )}
        </div>
        <div className="nav-list">
          {groups.map((g) => (
            <Link key={g.key} href={g.visible[0]!.href} className={groupActive(g) ? 'active' : ''} aria-current={groupActive(g) ? 'page' : undefined}>
              <Glyph name={g.glyph} size={24} />
              {t(g.label)}
              {g.key === 'operation' && pending > 0 && <span className="nav-badge" data-testid="pending-badge" aria-label={`${pending} ${t('req.pendingBadge')}`}>{pending}</span>}
            </Link>
          ))}
          {mine && (
            <Link href={mine.href} className={tabActive(pathname, mine.href) ? 'active' : ''} aria-current={tabActive(pathname, mine.href) ? 'page' : undefined}>
              <Icon name={mine.icon} size={24} />{t(mine.label)}
            </Link>
          )}
        </div>
        {org.branding.artUrl && <img src={org.branding.artUrl} alt="" className="brand-art" />}
        <div className="bottom">
          {me.memberships.length > 1 && <Link href="/seleccionar-negocio"><Glyph name="swap" size={22} />{t('nav.switchOrg')}</Link>}
          <button className="link" onClick={() => void logout()}><Glyph name="logout" size={22} />{t('nav.logout')}</button>
        </div>
      </nav>
      <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <div className="content">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label={open ? t('nav.closeMenu') : t('nav.menu')} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <Icon name={open ? 'close' : 'menu'} size={22} />
          </button>
          <div className="context" data-testid="context">
            <strong>{org.name}</strong>
            {today && <span className="op-day"><Icon name="calendar" size={18} /> {t('nav.today')}: <b>{today}</b></span>}
          </div>
          <span className="spacer" />
          {approver && (
            <Link href="/solicitudes" className={`bell ${pending > 0 ? 'ring' : ''}`} title={t('nav.notifications')} aria-label={`${t('nav.notifications')}: ${pending} ${t('req.pendingBadge')}`}>
              <Glyph name="bell" size={28} />
              {pending > 0 && <span className="bell-dot" aria-hidden="true" />}
            </Link>
          )}
          <div className="user-menu" ref={menuRef}>
            <button type="button" className="user-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
              <span className="who"><strong>{me.user.displayName}</strong><span>{me.user.email}</span></span>
              <span className="avatar" aria-hidden="true">{initial}<i className="online" /></span>
              <Glyph name="chevronDown" size={18} className="chev" />
            </button>
            {menu && (
              <div className="menu" role="menu">
                <Link href="/cuenta" role="menuitem"><Glyph name="user" size={18} />{t('nav.account')}</Link>
                {me.memberships.length > 1 && <Link href="/seleccionar-negocio" role="menuitem"><Glyph name="swap" size={18} />{t('nav.switchOrg')}</Link>}
                <button type="button" role="menuitem" onClick={() => void logout()}><Glyph name="logout" size={18} />{t('nav.logout')}</button>
              </div>
            )}
          </div>
        </header>
        <main><SectionTabs pending={pending} />{children}</main>
      </div>
    </div>
  );
}

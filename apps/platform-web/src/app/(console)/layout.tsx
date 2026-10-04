'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { Icon, type IconName } from '@/components/icons';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: '/', label: 'nav.summary', icon: 'home' },
  { href: '/clientes', label: 'nav.customers', icon: 'building' },
  { href: '/planes', label: 'nav.plans', icon: 'layers' },
  { href: '/operadores', label: 'nav.operators', icon: 'users' },
  { href: '/bitacora', label: 'nav.audit', icon: 'scroll' },
];

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  const { operator } = useSession();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  if (!operator) return null;
  const active = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const initial = (operator.displayName || operator.email).trim().charAt(0).toUpperCase();

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/login');
  }

  return (
    <div className={`shell ${open ? 'open' : ''}`}>
      <nav className="sidebar" aria-label="Principal">
        <div className="brand">
          <span className="brand-mark"><Icon name="shield" size={22} /></span>
          <div>
            <div className="org">{t('brand.name')}</div>
            <small>{t('brand.console')}</small>
          </div>
        </div>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={active(n.href) ? 'active' : ''} aria-current={active(n.href) ? 'page' : undefined}>
            <Icon name={n.icon} />{t(n.label)}
          </Link>
        ))}
        <div className="bottom">
          <Link href="/cuenta" className={active('/cuenta') ? 'active' : ''}><Icon name="user" />{t('nav.account')}</Link>
          <button className="link" onClick={() => void logout()}><Icon name="logout" />{t('nav.logout')}</button>
        </div>
      </nav>
      <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <div className="content">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label={open ? t('nav.closeMenu') : t('nav.menu')} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <Icon name={open ? 'close' : 'menu'} size={22} />
          </button>
          <div className="context"><strong>{t('brand.console')}</strong></div>
          <span className="spacer" />
          <span className="who"><strong>{operator.displayName}</strong><span>{operator.email}</span></span>
          <Link href="/cuenta" className="avatar" title={t('nav.account')} aria-hidden="true" tabIndex={-1}>{initial}</Link>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}

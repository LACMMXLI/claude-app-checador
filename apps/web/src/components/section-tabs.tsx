'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from '@/lib/session';
import { NAV_GROUPS, tabActive } from '@/lib/nav';
import { t } from '@/lib/i18n';

/**
 * Pestañas de la sección actual (Operación, Equipo, Configuración). Son enlaces reales: conservan URL directa, historial
 * y navegación atrás/adelante. Se ordenan con CSS (`main > .tabs`) justo debajo del título de cada pantalla.
 */
export function SectionTabs({ pending }: { pending: number }) {
  const pathname = usePathname();
  const { can } = useSession();
  const group = NAV_GROUPS.find((g) => g.tabs.some((x) => tabActive(pathname, x.href)));
  const tabs = group?.tabs.filter((x) => !x.permission || can(x.permission)) ?? [];
  if (!group || tabs.length < 2) return null;
  return (
    <nav className="tabs" aria-label={`${t('nav.sections')}: ${t(group.label)}`}>
      {tabs.map((x) => {
        const on = tabActive(pathname, x.href);
        return (
          <Link key={x.href} href={x.href} className={on ? 'active' : ''} aria-current={on ? 'page' : undefined}>
            {t(x.label)}
            {x.href === '/solicitudes' && pending > 0 && <span className="nav-badge" aria-label={`${pending} ${t('req.pendingBadge')}`}>{pending}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

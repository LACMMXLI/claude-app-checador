import type { IconName } from '@/components/icons';

export interface NavTab { href: string; label: string; permission: string | null }
export interface NavGroup { key: string; label: string; icon: IconName; tabs: readonly NavTab[] }

/**
 * Menú lateral en 6 grupos. Cada grupo agrupa vistas relacionadas que se muestran como pestañas dentro del contenido.
 * Las rutas y los permisos son los de siempre; solo cambia la organización visual (la autorización real es del backend).
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  { key: 'home', label: 'nav.dashboard', icon: 'home', tabs: [{ href: '/', label: 'nav.dashboard', permission: null }] },
  { key: 'live', label: 'nav.group.attendance', icon: 'activity', tabs: [{ href: '/asistencia', label: 'nav.group.attendance', permission: 'attendance.view' }] },
  {
    key: 'operation', label: 'nav.group.operation', icon: 'clock',
    tabs: [
      { href: '/jornadas', label: 'nav.sessions', permission: 'attendance.view' },
      { href: '/incidencias', label: 'nav.incidents', permission: 'attendance.view' },
      { href: '/solicitudes', label: 'nav.requests', permission: 'attendance.view' },
      { href: '/horario', label: 'nav.scheduleShort', permission: 'schedules.view' },
      { href: '/plantillas', label: 'nav.templates', permission: 'schedules.templates.manage' },
    ],
  },
  {
    key: 'team', label: 'nav.group.team', icon: 'users',
    tabs: [
      { href: '/empleados', label: 'nav.employees', permission: 'employees.view' },
      { href: '/usuarios', label: 'nav.users', permission: 'memberships.manage' },
      { href: '/kioscos', label: 'nav.kiosks', permission: 'kiosks.manage' },
    ],
  },
  { key: 'reports', label: 'nav.reports', icon: 'chart', tabs: [{ href: '/reportes', label: 'nav.reports', permission: 'reports.view' }] },
  {
    key: 'settings', label: 'nav.group.settings', icon: 'sliders',
    tabs: [
      { href: '/sucursales', label: 'nav.branches', permission: null },
      { href: '/politicas', label: 'nav.policies', permission: 'settings.manage' },
      { href: '/auditoria', label: 'nav.audit', permission: 'audit.view' },
      { href: '/cuenta', label: 'nav.account', permission: null },
    ],
  },
];

export const tabActive = (pathname: string, href: string) => pathname === href || (href !== '/' && pathname.startsWith(`${href}/`));

import type { SVGProps } from 'react';

/** Iconos de trazo (24×24) propios, sin dependencias. Siempre decorativos: el texto de al lado es el nombre accesible. */
const PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  activity: 'M3 12h4l3 8 4-16 3 8h4',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2m20 0-2.5-6.9A2 2 0 0 0 17.6 4H6.4a2 2 0 0 0-1.9 1.1L2 12m20 0v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6',
  chart: 'M4 20V10m6 10V4m6 16v-7m5 7H3',
  calendar: 'M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  layers: 'm12 2 10 5-10 5L2 7zm10 10-10 5-10-5m20 5-10 5-10-5',
  building: 'M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h4M8 11h4M8 15h4',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  tablet: 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm6 16h.01',
  sliders: 'M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3M1 14h6m2-6h6m2 8h6',
  scroll: 'M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4m4-3h8a2 2 0 0 1 2 2v10',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  userCheck: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m14-10 2 2 4-4M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9m-4.3 13a2 2 0 0 1-3.4 0',
  menu: 'M3 6h18M3 12h18M3 18h18',
  close: 'M18 6 6 18M6 6l12 12',
  check: 'm20 6-11 11-5-5',
  info: 'M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z',
  key: 'm21 2-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zm11 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M17.9 17.9A10.1 10.1 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.1-5.9m3.8-1.7A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2M1 1l22 22M14.1 14.1a3 3 0 1 1-4.2-4.2',
  swap: 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4m14 4v-2a4 4 0 0 0-4-4H3',
  sparkles: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z',
  plus: 'M12 5v14M5 12h14',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3',
  lock: 'M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zm2 0V7a5 5 0 0 1 10 0v4',
  empty: 'M3 7l2-3h14l2 3M3 7v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7M3 7h5l1 3h6l1-3h5',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="icon"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/**
 * Pictogramas rellenos del menú y del tablero (mismo estilo que el diseño de Inicio). Decorativos: el texto de al lado es el
 * nombre accesible. Se dibujan en 24×24 con `currentColor`.
 */
const GLYPHS = {
  home: <path d="M12 2.8 2.6 10.4a1 1 0 0 0-.4.8V20a1.2 1.2 0 0 0 1.2 1.2H8.6v-6.1h6.8v6.1h5.2A1.2 1.2 0 0 0 21.8 20v-8.8a1 1 0 0 0-.4-.8z" />,
  calendar: <path fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" d="M8 2.8v3.4m8-3.4v3.4M3.8 9.6h16.4M6 4.6h12a2.2 2.2 0 0 1 2.2 2.2v11.4A2.2 2.2 0 0 1 18 20.4H6a2.2 2.2 0 0 1-2.2-2.2V6.8A2.2 2.2 0 0 1 6 4.6z" />,
  store: <path fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" d="M3.2 9.3 4.6 4.2h14.8l1.4 5.1M3.2 9.3v.9a2.9 2.9 0 0 0 5.9 0 2.9 2.9 0 0 0 5.8 0 2.9 2.9 0 0 0 5.9 0v-.9M5 13.1v7.3h14v-7.3M10 20.4v-4.9h4v4.9" />,
  users: (
    <>
      <circle cx="12" cy="7.6" r="3.3" />
      <path d="M5.4 19.6c0-3.4 2.9-5.6 6.6-5.6s6.6 2.2 6.6 5.6v.9H5.4z" />
      <circle cx="4.9" cy="9.4" r="2.3" />
      <path d="M1.2 18.3c0-2.4 1.7-4 3.9-4 .6 0 1.2.1 1.7.3-1.1 1-1.8 2.4-1.8 4.1v.8H1.2z" />
      <circle cx="19.1" cy="9.4" r="2.3" />
      <path d="M22.8 18.3c0-2.4-1.7-4-3.9-4-.6 0-1.2.1-1.7.3 1.1 1 1.8 2.4 1.8 4.1v.8h3.8z" />
    </>
  ),
  chart: (
    <>
      <rect x="3.6" y="10.4" width="4.4" height="10" rx="1.1" />
      <rect x="9.8" y="3.6" width="4.4" height="16.8" rx="1.1" />
      <rect x="16" y="7.6" width="4.4" height="12.8" rx="1.1" />
    </>
  ),
  cog: <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6S10.02 8.4 12 8.4s3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9.4" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path d="M12 6.6v5.8l3.7 2.2" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  alert: <path fillRule="evenodd" d="M12 2.4 1.6 20.6h20.8zM11 9.2h2v5.6h-2zm0 7.4h2v2h-2z" />,
  document: <path fillRule="evenodd" d="M6 2h8l5.2 5.2V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.6V8h4.4zM7.6 12.2h8.8v1.7H7.6zm0 3.6h8.8v1.7H7.6zm0-7.2h3.4v1.7H7.6z" />,
  bell: <path d="M12 2.8a6.2 6.2 0 0 0-6.2 6.2c0 4.3-1.9 6-2.8 6.9v.9h18v-.9c-.9-.9-2.8-2.6-2.8-6.9A6.2 6.2 0 0 0 12 2.8zm-2.4 15.7a2.5 2.5 0 0 0 4.8 0z" />,
  chevronRight: <path fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d="m9 5.5 6.5 6.5L9 18.5" />,
  chevronDown: <path fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d="m5.5 9 6.5 6.5L18.5 9" />,
  arrowRight: <path fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" d="M4.5 12h15m-6-6 6 6-6 6" />,
  trendUp: <path fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d="M6 17.5 17.5 6M8.5 6H17.5v9" />,
  trendDown: <path fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d="M6 6.5 17.5 18M8.5 18H17.5V9" />,
  logout: <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M9.5 20.5h-4a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h4m6.5 12.5 5-5-5-5m5 5H9.5" />,
  user: <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M20 21v-1.6a4.2 4.2 0 0 0-4.2-4.2H8.2A4.2 4.2 0 0 0 4 19.4V21M12 11.4a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />,
  swap: <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M17 1.5 21 5.5l-4 4M3 11V9.5a4 4 0 0 1 4-4h14M7 22.5l-4-4 4-4m14 4V17a4 4 0 0 0-4-4H3" />,
} as const;

export type GlyphName = keyof typeof GLYPHS;

export function Glyph({ name, size = 22, className, ...rest }: { name: GlyphName; size?: number; className?: string } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" className={`glyph ${className ?? ''}`} {...rest}>
      {GLYPHS[name]}
    </svg>
  );
}

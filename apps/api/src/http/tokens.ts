import type { TrustedProxyConfig } from './client-ip.js';

export const CONTAINER = Symbol('CONTAINER');
export const PG_POOL = Symbol('PG_POOL');
export const HTTP_CONFIG = Symbol('HTTP_CONFIG');

export interface HttpConfig {
  /** `true` en producción: cookie `Secure` con prefijo `__Host-` (solo HTTPS, sin Domain, Path=/). */
  secureCookies: boolean;
  /** Tiempos del SSE (D-75); configurables para pruebas. */
  sse?: Partial<SseConfig>;
  /** D-79: proxies confiables para obtener la IP real del cliente. Sin valor: no se confía en ninguno. */
  trustedProxies?: TrustedProxyConfig;
}

export interface SseConfig {
  pingMs: number;
  revalidateMs: number;
  maxLifetimeMs: number;
  maxPerUser: number;
}

export const SSE_DEFAULTS: SseConfig = { pingMs: 25_000, revalidateMs: 60_000, maxLifetimeMs: 30 * 60_000, maxPerUser: 5 };

export const sessionCookieName = (cfg: HttpConfig) => (cfg.secureCookies ? '__Host-sid' : 'sid');
/** Credencial del navegador del kiosco (D-56): HttpOnly, nunca en localStorage. */
export const kioskCookieName = (cfg: HttpConfig) => (cfg.secureCookies ? '__Host-kiosk' : 'kiosk');

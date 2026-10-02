export const CONTAINER = Symbol('CONTAINER');
export const PG_POOL = Symbol('PG_POOL');
export const HTTP_CONFIG = Symbol('HTTP_CONFIG');

export interface HttpConfig {
  /** `true` en producción: cookie `Secure` con prefijo `__Host-` (solo HTTPS, sin Domain, Path=/). */
  secureCookies: boolean;
}

export const sessionCookieName = (cfg: HttpConfig) => (cfg.secureCookies ? '__Host-sid' : 'sid');

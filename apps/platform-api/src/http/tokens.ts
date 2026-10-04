import type { TrustedProxyConfig } from '@checador/api/platform';

export const CONTAINER = Symbol('PLATFORM_CONTAINER');
export const HTTP_CONFIG = Symbol('PLATFORM_HTTP_CONFIG');
export const HEALTH_CHECK = Symbol('PLATFORM_HEALTH_CHECK');

export interface HttpConfig {
  /** `true` en producción: cookie `Secure` con prefijo `__Host-` (solo HTTPS, sin Domain, Path=/). */
  secureCookies: boolean;
  /** Proxies confiables para la IP real del cliente (solo informativa: sesiones y auditoría). */
  trustedProxies?: TrustedProxyConfig;
}

export const sessionCookieName = (cfg: HttpConfig) => (cfg.secureCookies ? '__Host-psid' : 'psid');
/** Cabecera exigida en toda petición que modifica estado (defensa CSRF de la cookie de sesión). */
export const CSRF_HEADER_VALUE = 'platform';

import { BlockList, isIP } from 'node:net';
import type { Request } from 'express';

/**
 * IP real del cliente detrás de proxies (D-79). SOLO es un dato informativo (auditoría, sesiones y "última IP" de un
 * kiosco): nunca autentica, autoriza, identifica sucursal ni aplica reglas de negocio.
 *
 * Camino en producción: cliente → Traefik (Coolify) → `web` (Next.js, proxy /api) → `api`.
 *  - Traefik pone en `X-Forwarded-For` la IP del cliente que lo contactó (y, por defecto, descarta la que mande un
 *    cliente no confiable).
 *  - `web` reenvía ese `X-Forwarded-For` tal cual (Next.js solo lo completa con el par TCP cuando no viene ninguno).
 *  - La API ve como par TCP al contenedor `web`.
 *
 * Regla: la API recorre la cadena de DERECHA a IZQUIERDA (par TCP, luego la última entrada de `X-Forwarded-For`, …) y
 * solo "salta" un salto si (a) aún no se han saltado `hops` saltos y (b) esa dirección pertenece a `TRUSTED_PROXIES`.
 * La primera dirección que no se salta es la IP del cliente. Así, lo que un cliente escriba más a la izquierda en
 * `X-Forwarded-For` nunca se usa, y un par que no es de nuestra infraestructura no puede alterar la IP registrada.
 * Sin configuración (por defecto) no se confía en nadie: se usa la IP del par TCP.
 */
export interface TrustedProxyConfig {
  /** Lista separada por comas de IPs, redes CIDR o los alias `loopback`, `linklocal`, `uniquelocal`. Vacía = nadie. */
  proxies: string;
  /** Saltos máximos a confiar (proxies propios entre el cliente y la API). 0 = ninguno. */
  hops: number;
}

const PRESETS: Record<string, string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

/** `::ffff:10.0.0.5` → `10.0.0.5`. */
export function normalizeIp(address: string): string {
  const a = address.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  return mapped ? mapped[1]! : a;
}

/** Valida la lista y devuelve la prueba de pertenencia. Falla al arrancar si hay una entrada inválida. */
export function compileTrustedNetworks(spec: string): (address: string) => boolean {
  const list = new BlockList();
  let entries = 0;
  for (const raw of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    for (const entry of PRESETS[raw.toLowerCase()] ?? [raw]) {
      const [ip, prefix] = entry.split('/');
      const family = isIP(ip ?? '');
      const bits = prefix === undefined ? (family === 6 ? 128 : 32) : Number(prefix);
      if (!family || !Number.isInteger(bits) || bits < 0 || bits > (family === 6 ? 128 : 32)) {
        throw new Error(`TRUSTED_PROXIES: entrada inválida "${raw}" (usa IP, red CIDR o loopback/linklocal/uniquelocal)`);
      }
      list.addSubnet(ip!, bits, family === 6 ? 'ipv6' : 'ipv4');
      entries += 1;
    }
  }
  if (entries === 0) return () => false;
  return (address: string) => {
    const a = normalizeIp(address);
    const family = isIP(a);
    return family !== 0 && list.check(a, family === 6 ? 'ipv6' : 'ipv4');
  };
}

/** Función para `app.set('trust proxy', …)` de Express: `(dirección, salto)` con salto 0 = par TCP. */
export function trustProxyFn(config: TrustedProxyConfig): (address: string, hop: number) => boolean {
  const hops = Math.max(0, Math.floor(config.hops));
  const trusted = compileTrustedNetworks(config.proxies);
  return (address, hop) => hop < hops && trusted(address);
}

/** Lee la configuración del entorno: `TRUSTED_PROXIES` (vacío) y `TRUSTED_PROXY_HOPS` (1 si hay proxies, si no 0). */
export function trustedProxyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TrustedProxyConfig {
  const proxies = (env.TRUSTED_PROXIES ?? '').trim();
  const rawHops = (env.TRUSTED_PROXY_HOPS ?? '').trim();
  const hops = rawHops === '' ? (proxies ? 1 : 0) : Number(rawHops);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) throw new Error('TRUSTED_PROXY_HOPS debe ser un entero entre 0 y 10');
  compileTrustedNetworks(proxies); // valida al arrancar
  return { proxies, hops };
}

/**
 * ÚNICO punto para obtener la IP del cliente (auditoría, sesiones, `last_seen_ip`). Express ya la calculó con la
 * función de confianza (`req.ip`); aquí solo se normaliza y se acota (≤ 64 caracteres).
 */
export function clientIp(req: Request): string | null {
  const ip = req.ip ?? req.socket?.remoteAddress ?? null;
  return ip ? normalizeIp(ip).slice(0, 64) : null;
}

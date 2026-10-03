import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileTrustedNetworks, normalizeIp, trustProxyFn, trustedProxyConfigFromEnv } from '../src/http/client-ip.js';
import type { HttpConfig } from '../src/http/tokens.js';
import { type AttendanceFixture, attendanceFixture } from './helpers/attendance-fixture.js';
import { Agent, startServer, type TestServer } from './helpers/http.js';
import { PASSWORD, buildWorld, openPools } from './helpers/world.js';

/**
 * D-79 · IP real del cliente detrás de proxies. Las pruebas se conectan desde 127.0.0.1: según la configuración, ese par
 * TCP hace de "contenedor web" confiable (cadena cliente → Traefik → web → api) o de cliente directo.
 */
const pools = openPools();
let now = new Date('2026-09-01T12:00:00Z');
const world = buildWorld(pools, { clock: () => now });
let F: AttendanceFixture;
const servers: TestServer[] = [];
let admin: Agent;

async function server(http: Partial<HttpConfig>) {
  const s = await startServer(pools, world, false, http);
  servers.push(s);
  return s;
}

beforeAll(async () => {
  F = await attendanceFixture(world, (d) => (now = d));
  const s = await server({});
  admin = new Agent(s.baseUrl);
  await admin.login(F.adminEmail, PASSWORD);
});
afterAll(async () => {
  for (const s of servers) await s.close();
  await pools.close();
});

/**
 * Tablet nueva en el servidor `s`: se activa (sin cabeceras), luego hace una petición con `headers` (p. ej. un
 * X-Forwarded-For) y checa una Entrada con las MISMAS cabeceras. Devuelve la `last_seen_ip` guardada y la IP de la
 * auditoría de esa Entrada.
 */
async function observe(s: TestServer, headers: Record<string, string>) {
  const created = await admin.post('/api/kiosks', { name: `IP-${randomUUID().slice(0, 6)}`, branchId: F.VEN });
  const tablet = new Agent(s.baseUrl);
  expect((await tablet.post('/api/kiosk/activate', { credential: created.body.token })).status).toBe(200);
  expect((await tablet.get('/api/kiosk/session', headers)).status).toBe(200);
  const person = await F.employee(`Ip${randomUUID().slice(0, 4)}`, F.VEN);
  const who = await tablet.post('/api/kiosk/identify', { pin: person.pin }, headers);
  const punched = await tablet.post('/api/kiosk/punch', { ticket: who.body.ticket, action: 'CLOCK_IN', clientEventId: randomUUID() }, headers);
  expect(punched.status).toBe(200);
  const device = (await pools.platform.query('SELECT last_seen_ip FROM core.kiosk_devices WHERE id = $1', [created.body.device.id])).rows[0];
  const audit = (await pools.platform.query(`SELECT ip FROM audit.audit_log WHERE action = 'attendance.clock_in' AND entity_id = $1`, [punched.body.workSessionId])).rows[0];
  return { lastSeenIp: device.last_seen_ip as string | null, auditIp: audit.ip as string | null };
}

describe('regla de confianza (pura)', () => {
  it('redes por alias, CIDR e IP; IPv4 mapeada a IPv6 se normaliza; entradas inválidas detienen el arranque', () => {
    const trusted = compileTrustedNetworks('loopback, uniquelocal, 198.51.100.0/24, 2001:db8::1');
    for (const ip of ['127.0.0.1', '::1', '10.0.3.7', '172.18.0.4', '192.168.1.20', '::ffff:172.18.0.4', '198.51.100.250', '2001:db8::1']) expect(trusted(ip)).toBe(true);
    for (const ip of ['203.0.113.7', '8.8.8.8', '172.32.0.1', '2001:db8::2', 'no-es-ip']) expect(trusted(ip)).toBe(false);
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(() => compileTrustedNetworks('10.0.0.0/33')).toThrow(/TRUSTED_PROXIES/);
    expect(() => compileTrustedNetworks('mi-servidor')).toThrow(/TRUSTED_PROXIES/);
  });

  it('nunca se salta más de N saltos aunque la dirección sea de confianza; sin configuración no se confía en nadie', () => {
    const fn = trustProxyFn({ proxies: 'loopback', hops: 1 });
    expect(fn('127.0.0.1', 0)).toBe(true);
    expect(fn('127.0.0.1', 1)).toBe(false);
    expect(trustProxyFn({ proxies: '', hops: 3 })('127.0.0.1', 0)).toBe(false);
    expect(trustedProxyConfigFromEnv({})).toEqual({ proxies: '', hops: 0 });
    expect(trustedProxyConfigFromEnv({ TRUSTED_PROXIES: 'loopback,uniquelocal' })).toEqual({ proxies: 'loopback,uniquelocal', hops: 1 });
    expect(() => trustedProxyConfigFromEnv({ TRUSTED_PROXIES: 'loopback', TRUSTED_PROXY_HOPS: '-1' })).toThrow(/TRUSTED_PROXY_HOPS/);
  });
});

describe('IP registrada (auditoría y last_seen_ip) por HTTP', () => {
  it('petición directa sin proxy configurado: se usa el par TCP y se ignora cualquier X-Forwarded-For', async () => {
    const s = await server({});
    expect(await observe(s, {})).toEqual({ lastSeenIp: '127.0.0.1', auditIp: '127.0.0.1' });
    // un cliente que intenta falsificar su IP
    expect(await observe(s, { 'x-forwarded-for': '6.6.6.6' })).toEqual({ lastSeenIp: '127.0.0.1', auditIp: '127.0.0.1' });
  });

  it('a través del proxy confiable (web en red propia, 1 salto): se registra la IP que puso Traefik', async () => {
    const s = await server({ trustedProxies: { proxies: 'loopback', hops: 1 } });
    expect(await observe(s, { 'x-forwarded-for': '203.0.113.7' })).toEqual({ lastSeenIp: '203.0.113.7', auditIp: '203.0.113.7' });
    // sin cabecera (p. ej. llamada interna): se queda con el par
    expect(await observe(s, {})).toEqual({ lastSeenIp: '127.0.0.1', auditIp: '127.0.0.1' });
  });

  it('varios valores en X-Forwarded-For: solo cuenta el que agregó nuestro proxy (el de la derecha); lo inyectado a la izquierda se ignora', async () => {
    const s = await server({ trustedProxies: { proxies: 'loopback', hops: 1 } });
    expect(await observe(s, { 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 203.0.113.7' })).toEqual({ lastSeenIp: '203.0.113.7', auditIp: '203.0.113.7' });
  });

  it('con dos saltos propios (p. ej. CDN + Traefik), el segundo salto debe ser de una red confiable', async () => {
    const s = await server({ trustedProxies: { proxies: 'loopback, 198.51.100.0/24', hops: 2 } });
    expect(await observe(s, { 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 198.51.100.4' })).toEqual({ lastSeenIp: '203.0.113.7', auditIp: '203.0.113.7' });
    // si el penúltimo salto no es nuestro, NO se sigue hacia la izquierda: se registra esa dirección
    expect(await observe(s, { 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 9.9.9.9' })).toEqual({ lastSeenIp: '9.9.9.9', auditIp: '9.9.9.9' });
  });

  it('un par que NO es proxy confiable no puede alterar la IP registrada con X-Forwarded-For', async () => {
    const s = await server({ trustedProxies: { proxies: '10.0.0.0/8', hops: 1 } }); // las pruebas llegan desde 127.0.0.1
    expect(await observe(s, { 'x-forwarded-for': '203.0.113.7' })).toEqual({ lastSeenIp: '127.0.0.1', auditIp: '127.0.0.1' });
  });

  it('la sesión del panel guarda la misma IP calculada (login)', async () => {
    const s = await server({ trustedProxies: { proxies: 'loopback', hops: 1 } });
    const agent = new Agent(s.baseUrl);
    const r = await agent.request('POST', '/api/auth/login', { email: F.adminEmail, password: PASSWORD }, { 'x-forwarded-for': '6.6.6.6, 203.0.113.8' });
    expect(r.status).toBe(200);
    const row = (await pools.superuser.query(`SELECT ip FROM auth.sessions ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(row.ip).toBe('203.0.113.8');
  });
});

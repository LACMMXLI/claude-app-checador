import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/auth/password.js';
import { Agent, startServer, type TestServer } from './helpers/http.js';
import { PASSWORD, buildWorld, openPools, uniq } from './helpers/world.js';

/** D-80 · Cambio de contraseña por la propia persona (la contraseña es global: pertenece a la plataforma, RN-IDN-02). */
const pools = openPools();
const world = buildWorld(pools);
let server: TestServer;
let email: string;
let orgA: string;
let orgB: string;

const NEW = 'nueva-contraseña-segura-1';

beforeAll(async () => {
  server = await startServer(pools, world);
  const slug = uniq('pw-a');
  const a = await world.platformAdmin.createOrganization({ name: 'A', slug, timezone: 'America/Tijuana', branches: [{ code: 'X', name: 'X' }], admin: { email: `${slug}@ejemplo.com`, displayName: 'Admin A', password: PASSWORD } });
  email = `${slug}@ejemplo.com`;
  orgA = a.organizationId;
  // la misma persona (identidad global) es miembro también de otro negocio
  const slugB = uniq('pw-b');
  const b = await world.platformAdmin.createOrganization({ name: 'B', slug: slugB, timezone: 'America/Tijuana', branches: [{ code: 'Y', name: 'Y' }], admin: { email, displayName: 'Admin A' } });
  orgB = b.organizationId;
});
afterAll(async () => {
  await server.close();
  await pools.close();
});

const login = async (password = PASSWORD) => {
  const agent = new Agent(server.baseUrl);
  const r = await agent.post('/api/auth/login', { email, password });
  return { agent, r };
};

describe('cambiar la propia contraseña', () => {
  it('exige la contraseña actual, una nueva distinta y de 10+ caracteres; el bloqueo por intentos aplica', async () => {
    const { agent } = await login();
    await agent.post('/api/auth/switch-organization', { organizationId: orgA });
    const wrong = await agent.post('/api/auth/change-password', { currentPassword: 'no-es-esta', newPassword: NEW });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('CURRENT_PASSWORD_INVALID');
    expect((await agent.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'corta' })).body.error.code).toBe('PASSWORD_TOO_SHORT');
    expect((await agent.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: PASSWORD })).body.error.code).toBe('NEW_PASSWORD_SAME_AS_CURRENT');
    expect((await agent.get('/api/auth/me')).status).toBe(200); // nada de eso cierra la sesión ni cambia la contraseña
    expect((await login()).r.status).toBe(200);
  });

  it('sin sesión no hay cambio; el cuerpo se valida', async () => {
    const anon = new Agent(server.baseUrl);
    expect((await anon.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: NEW })).status).toBe(401);
    const { agent } = await login();
    expect((await agent.post('/api/auth/change-password', { currentPassword: PASSWORD })).status).toBe(400);
  });

  it('cambia la contraseña, conserva ESTA sesión, cierra las demás y la anterior deja de servir', async () => {
    const { agent: current } = await login();
    const { agent: other } = await login(); // p. ej. alguien más con su sesión abierta
    expect((await other.get('/api/auth/me')).status).toBe(200);
    const r = await current.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: NEW });
    expect(r.status).toBe(200);
    expect(r.body.otherSessionsRevoked).toBeGreaterThanOrEqual(1);
    expect((await current.get('/api/auth/me')).status).toBe(200); // la actual sigue
    expect((await other.get('/api/auth/me')).status).toBe(401); // la otra ya no
    expect((await login(PASSWORD)).r.status).toBe(401); // la anterior ya no sirve
    expect((await login(NEW)).r.status).toBe(200);
    // se puede volver a cambiar (con la nueva como actual)
    expect((await current.post('/api/auth/change-password', { currentPassword: NEW, newPassword: PASSWORD })).status).toBe(200);
    expect((await login(PASSWORD)).r.status).toBe(200);
  });

  it('se audita en CADA negocio de la persona, sin contraseña ni hash', async () => {
    const rows = (await pools.platform.query(`SELECT organization_id, actor_user_id, after, before, reason FROM audit.audit_log WHERE action = 'user.password_changed' AND organization_id = ANY($1)`, [[orgA, orgB]])).rows;
    expect(new Set(rows.map((r) => r.organization_id))).toEqual(new Set([orgA, orgB]));
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/argon2|\$argon|nueva-contraseña|nueva_contrase/i);
    expect(text).not.toContain(PASSWORD);
  });

  it('el bloqueo por intentos fallidos también protege este camino', async () => {
    const slug = uniq('pw-lock');
    const addr = `${slug}@ejemplo.com`;
    await world.platformAdmin.createOrganization({ name: 'L', slug, timezone: 'America/Tijuana', branches: [], admin: { email: addr, displayName: 'L', password: PASSWORD } });
    const agent = new Agent(server.baseUrl);
    await agent.post('/api/auth/login', { email: addr, password: PASSWORD });
    for (let i = 0; i < 5; i += 1) await agent.post('/api/auth/change-password', { currentPassword: 'mal-mal-mal-mal', newPassword: NEW });
    const locked = await agent.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: NEW });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });
});

describe('PostgreSQL: único camino y compare-and-set', () => {
  it('app_user no puede tocar las credenciales directamente', async () => {
    const c = await pools.app.connect();
    try {
      await expect(c.query(`UPDATE auth.user_credentials SET password_hash = 'x'`)).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`SELECT password_hash FROM auth.user_credentials`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      c.release();
    }
  });

  it('con un hash antiguo (cambio concurrente) la función rechaza y no pisa la contraseña vigente', async () => {
    const record = await world.gate.getLoginRecord(email);
    const stale = await hashPassword('otra-contraseña-vieja-123');
    await expect(world.gate.changePassword(record!.userId, stale, await hashPassword(NEW), null)).rejects.toMatchObject({ code: 'PASSWORD_CHANGED_CONCURRENTLY' });
    expect((await login(PASSWORD)).r.status).toBe(200);
  });
});

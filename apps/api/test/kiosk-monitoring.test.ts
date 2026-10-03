import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AttendanceFixture, attendanceFixture } from './helpers/attendance-fixture.js';
import { Agent, startServer, type TestServer } from './helpers/http.js';
import { PASSWORD, buildWorld, openPools, userCtx } from './helpers/world.js';

const pools = openPools();
let now = new Date('2026-09-01T12:00:00Z');
const world = buildWorld(pools, { clock: () => now });
let server: TestServer;
let F: AttendanceFixture;
let admin: Agent;

beforeAll(async () => {
  F = await attendanceFixture(world, (d) => (now = d));
  server = await startServer(pools, world);
  admin = new Agent(server.baseUrl);
  await admin.login(F.adminEmail, PASSWORD);
});
afterAll(async () => {
  await server.close();
  await pools.close();
});

const device = async (id: string) => (await admin.get('/api/kiosks')).body.find((d: { id: string }) => d.id === id);

describe('control de kioscos (D-76)', () => {
  it('estado derivado: pendiente de activar → activo → (regenerar) pendiente → (revocar) sin credencial; inactivo', async () => {
    const created = await admin.post('/api/kiosks', { name: 'Tablet estados', branchId: F.VEN });
    const id = created.body.device.id as string;
    expect(await device(id)).toMatchObject({ state: 'PENDING_ACTIVATION', activatedAt: null, lastSeenAt: null });
    const tablet = new Agent(server.baseUrl);
    await tablet.post('/api/kiosk/activate', { credential: created.body.token });
    const active = await device(id);
    expect(active).toMatchObject({ state: 'ACTIVE' });
    expect(active.activatedAt).toBeTruthy();
    const regen = await admin.post(`/api/kiosks/${id}/token`, { reason: 'Tablet nueva' });
    expect(regen.body.device.state).toBe('PENDING_ACTIVATION');
    expect((await tablet.get('/api/kiosk/session')).status).toBe(401); // la credencial anterior ya no sirve
    await new Agent(server.baseUrl).post('/api/kiosk/activate', { credential: regen.body.token });
    expect((await device(id)).state).toBe('ACTIVE');
    await admin.post(`/api/kiosks/${id}/status`, { status: 'INACTIVE', reason: 'Reparación' });
    expect((await device(id)).state).toBe('INACTIVE');
    await admin.post(`/api/kiosks/${id}/token/revoke`, { reason: 'Robada' });
    expect((await device(id)).state).toBe('NO_CREDENTIAL');
  });

  it('canjear un código de emparejamiento activa el dispositivo', async () => {
    const code = await world.kiosks.createPairingCode(F.ctx, F.SMA);
    const tablet = new Agent(server.baseUrl);
    const act = await tablet.post('/api/kiosk/activate', { credential: code.code, deviceName: 'Tablet SMA' });
    const d = await device(act.body.device.id);
    expect(d).toMatchObject({ state: 'ACTIVE', name: 'Tablet SMA' });
    expect(d.activatedAt).toBeTruthy();
  });

  it('último uso e IP: se actualizan con el uso, a lo más una vez por minuto', async () => {
    const created = await admin.post('/api/kiosks', { name: 'Tablet uso', branchId: F.VEN });
    const tablet = new Agent(server.baseUrl);
    await tablet.post('/api/kiosk/activate', { credential: created.body.token });
    await tablet.get('/api/kiosk/session');
    const first = await device(created.body.device.id);
    expect(first.lastSeenAt).toBeTruthy();
    expect(first.lastSeenIp).toMatch(/127\.0\.0\.1/);
    await tablet.get('/api/kiosk/session');
    expect((await device(created.body.device.id)).lastSeenAt).toBe(first.lastSeenAt); // dentro del minuto: sin escribir
    await pools.superuser.query(`UPDATE core.kiosk_devices SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`, [created.body.device.id]);
    await tablet.get('/api/kiosk/session');
    expect(new Date((await device(created.body.device.id)).lastSeenAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('"revocar ahora" deja fuera al navegador en su siguiente petición aunque su cookie siga vigente', async () => {
    const created = await admin.post('/api/kiosks', { name: 'Tablet revocar', branchId: F.VEN });
    const tablet = new Agent(server.baseUrl);
    const act = await tablet.post('/api/kiosk/activate', { credential: created.body.token });
    expect(act.headers.getSetCookie().find((c) => c.startsWith('kiosk='))).toMatch(/Max-Age=31536000/);
    expect((await tablet.get('/api/kiosk/session')).status).toBe(200);
    await admin.post(`/api/kiosks/${created.body.device.id}/token/revoke`, { reason: 'Perdida' });
    expect((await tablet.get('/api/kiosk/session')).body.error.code).toBe('KIOSK_TOKEN_INVALID');
    const audit = await pools.platform.query(`SELECT action FROM audit.audit_log WHERE entity_id = $1 ORDER BY id`, [created.body.device.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['kiosk.created', 'kiosk.activated', 'kiosk.token_revoked']);
  });
});

describe('override de política desde el CLI de plataforma (Fatboy sin nombres fijos en el código)', () => {
  it('fija break_required_after_min = 360 y exit_tolerance_min = 5 a nivel negocio, validado y auditado', async () => {
    const slug = (await pools.platform.query('SELECT slug FROM core.organizations WHERE id = $1', [F.orgId])).rows[0].slug;
    await world.platformAdmin.setOrganizationPolicy(slug, { breakRequiredAfterMin: 360, exitToleranceMin: 5 });
    const { policy, sources } = await world.policies.getEffective(userCtx(F.orgId, F.ctx.actor.userId), { branchId: F.VEN });
    expect(policy).toMatchObject({ breakRequiredAfterMin: 360, exitToleranceMin: 5, debounceSec: 0 }); // conserva lo demás
    expect(sources).toMatchObject({ breakRequiredAfterMin: 'ORGANIZATION', exitToleranceMin: 'ORGANIZATION' });
    await expect(world.platformAdmin.setOrganizationPolicy(slug, { exitToleranceMin: 999 })).rejects.toMatchObject({ code: 'POLICY_VALUE_INVALID' });
    await expect(world.platformAdmin.setOrganizationPolicy('no-existe', { exitToleranceMin: 5 })).rejects.toMatchObject({ code: 'ORGANIZATION_NOT_FOUND' });
    const logs = await pools.platform.query(`SELECT action FROM platform.platform_audit_log WHERE organization_id = $1 AND action = 'policy.override_set'`, [F.orgId]);
    expect(logs.rowCount).toBe(1);
  });
});

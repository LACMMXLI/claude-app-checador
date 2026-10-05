import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, startServer, type TestServer } from './helpers/http.js';
import { PASSWORD, buildWorld, openPools, uniq } from './helpers/world.js';

/** Imágenes de marca por negocio: se configuran desde plataforma, llegan saneadas al panel y nunca viven en el código. */
const pools = openPools();
const world = buildWorld(pools);
let server: TestServer;
beforeAll(async () => { server = await startServer(pools, world); });
afterAll(async () => { await server.close(); await pools.close(); });

async function tenant() {
  const slug = uniq('marca');
  const email = `${slug}@ejemplo.com`;
  await world.platformAdmin.createOrganization({ name: slug, slug, timezone: 'America/Tijuana', admin: { email, displayName: 'A', password: PASSWORD } });
  const admin = new Agent(server.baseUrl);
  await admin.login(email, PASSWORD);
  return { slug, admin };
}

describe('branding del negocio', () => {
  it('sin configurar no hay imágenes; configurado, /auth/me las entrega solo para ese negocio', async () => {
    const a = await tenant();
    const b = await tenant();
    expect((await a.admin.get('/api/auth/me')).body.activeOrganization.branding).toEqual({});
    await world.platformAdmin.setOrganizationBranding(a.slug, { logoUrl: '/brand/a-logo.png', artUrl: 'https://cdn.ejemplo.com/arte.png' });
    expect((await a.admin.get('/api/auth/me')).body.activeOrganization.branding).toEqual({ logoUrl: '/brand/a-logo.png', artUrl: 'https://cdn.ejemplo.com/arte.png' });
    expect((await b.admin.get('/api/auth/me')).body.activeOrganization.branding).toEqual({});
    // quitar una imagen
    await world.platformAdmin.setOrganizationBranding(a.slug, { artUrl: null });
    expect((await a.admin.get('/api/auth/me')).body.activeOrganization.branding).toEqual({ logoUrl: '/brand/a-logo.png' });
  });

  it('rechaza valores peligrosos y, aunque algo malo llegara a la columna, el panel nunca lo recibe', async () => {
    const a = await tenant();
    for (const bad of ['javascript:alert(1)', 'data:image/svg+xml;base64,AAAA', 'http://inseguro.com/x.png', '//otro.com/x.png', '/brand/../secreto.png', '/otra/ruta.png', 'https://x.com/a b']) {
      await expect(world.platformAdmin.setOrganizationBranding(a.slug, { logoUrl: bad }), bad).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    await expect(world.platformAdmin.setOrganizationBranding(a.slug, {})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(world.platformAdmin.setOrganizationBranding('no-existe', { logoUrl: '/brand/x.png' })).rejects.toMatchObject({ code: 'ORGANIZATION_NOT_FOUND' });
    await pools.superuser.query(`UPDATE core.organizations SET branding = '{"logoUrl":"javascript:alert(1)","artUrl":"/brand/ok.png","otra":"x"}' WHERE slug = $1`, [a.slug]);
    expect((await a.admin.get('/api/auth/me')).body.activeOrganization.branding).toEqual({ artUrl: '/brand/ok.png' });
  });

  it('queda en la bitácora del negocio y en la de plataforma', async () => {
    const a = await tenant();
    await world.platformAdmin.setOrganizationBranding(a.slug, { logoUrl: '/brand/x.png' }, 'prueba:cli');
    const audit = await pools.superuser.query(`SELECT action FROM audit.audit_log WHERE action = 'organization.branding_set' AND reason LIKE '%prueba:cli%'`);
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
    const plat = await pools.superuser.query(`SELECT 1 FROM platform.platform_audit_log WHERE action = 'organization.branding_set' AND actor = 'prueba:cli'`);
    expect(plat.rowCount).toBeGreaterThanOrEqual(1);
  });
});

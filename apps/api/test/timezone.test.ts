import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, effectiveTimezone, isValidTimezone, localDate } from '../src/common/time.js';
import { pgError } from './helpers/sql.js';
import { PASSWORD, buildWorld, openPools, uniq, userCtx } from './helpers/world.js';

describe('zona horaria (puro)', () => {
  it('valida zonas IANA y rechaza abreviaturas o basura', () => {
    expect(['America/Tijuana', 'America/Mexico_City', 'UTC', 'Europe/Madrid'].every(isValidTimezone)).toBe(true);
    expect(['', 'EST', 'PST', 'Mars/Phobos', 'tijuana', 'GMT-8'].some(isValidTimezone)).toBe(false);
  });

  it('la fecha local depende de la zona: un mismo instante UTC cae en días distintos', () => {
    const instant = new Date('2030-03-10T03:30:00Z');
    expect(localDate(instant, 'UTC')).toBe('2030-03-10');
    expect(localDate(instant, 'America/Tijuana')).toBe('2030-03-09');
    expect(localDate(new Date('2030-03-10T07:30:00Z'), 'America/Mexico_City')).toBe('2030-03-10');
    expect(addDays('2030-03-01', -1)).toBe('2030-02-28');
  });

  it('la sucursal hereda la zona del negocio y puede sobrescribirla', () => {
    expect(effectiveTimezone(null, 'America/Tijuana')).toBe('America/Tijuana');
    expect(effectiveTimezone(undefined, 'America/Tijuana')).toBe('America/Tijuana');
    expect(effectiveTimezone('America/Mexico_City', 'America/Tijuana')).toBe('America/Mexico_City');
  });
});

const pools = openPools();
const world = buildWorld(pools);
let orgId: string;
let ctx: ReturnType<typeof userCtx>;
let branchIds: Record<string, string>;

beforeAll(async () => {
  const org = await world.platformAdmin.createOrganization({
    name: 'Fatboy', slug: uniq('fatboy'), timezone: 'America/Tijuana',
    branches: [{ code: 'VEN', name: 'Venecia' }, { code: 'SMA', name: 'San Marcos' }],
    admin: { email: `${uniq('d')}@ejemplo.com`, displayName: 'D', password: PASSWORD },
  });
  orgId = org.organizationId;
  branchIds = org.branchIds;
  ctx = userCtx(orgId, org.adminUserId);
});
afterAll(() => pools.close());

describe('zona horaria obligatoria al crear un negocio (D-1)', () => {
  const base = { name: 'X', slug: '', branches: [], admin: { email: 'a@b.com', displayName: 'A', password: PASSWORD } };

  it('sin zona, vacía o inválida NO se crea el negocio', async () => {
    for (const timezone of [undefined, '', 'EST', 'Mars/Phobos', 'Mexico']) {
      await expect(world.platformAdmin.createOrganization({ ...base, slug: uniq('tz'), timezone } as never), String(timezone)).rejects.toMatchObject({ code: 'INVALID_ORGANIZATION_INPUT' });
    }
  });

  it('PostgreSQL también la exige: NOT NULL y validada contra la base IANA (aunque se salte la aplicación)', async () => {
    const c = await pools.platform.connect();
    try {
      await c.query('BEGIN');
      expect((await pgError(c, `INSERT INTO core.organizations (slug, name) VALUES ('sin-tz', 'x')`))?.code).toBe('23502');
      expect((await pgError(c, `INSERT INTO core.organizations (slug, name, timezone) VALUES ('tz-mala', 'x', 'Mars/Phobos')`))?.code).toBe('22023');
      expect((await pgError(c, `INSERT INTO core.organizations (slug, name, timezone) VALUES ('tz-abrev', 'x', 'EST')`))?.code).toBe('22023');
      expect((await pgError(c, `INSERT INTO core.branches (organization_id, code, name, timezone) VALUES ($1, 'Z', 'z', 'Nope/Nada')`, [orgId]))?.code).toBe('22023');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('el negocio guarda su zona (Fatboy = America/Tijuana) y la CLI también la exige', async () => {
    const { rows } = await pools.platform.query(`SELECT timezone FROM core.organizations WHERE id = $1`, [orgId]);
    expect(rows[0].timezone).toBe('America/Tijuana');
  });
});

describe('herencia de zona horaria: negocio → sucursal', () => {
  it('la sucursal hereda la del negocio (timezone NULL) y puede sobrescribirla', async () => {
    expect(await world.branches.getEffectiveTimezone(ctx, branchIds.VEN!)).toBe('America/Tijuana');
    const stored = (await pools.platform.query(`SELECT timezone FROM core.branches WHERE id = $1`, [branchIds.VEN])).rows[0].timezone;
    expect(stored).toBeNull(); // hereda: no se duplica el valor

    await world.branches.update(ctx, branchIds.SMA!, { timezone: 'America/Mexico_City' }, 'Sucursal en otra zona');
    expect(await world.branches.getEffectiveTimezone(ctx, branchIds.SMA!)).toBe('America/Mexico_City');
    expect(await world.branches.getEffectiveTimezone(ctx, branchIds.VEN!)).toBe('America/Tijuana');
  });

  it('si el negocio cambia de zona, las sucursales que heredan la siguen; las que sobrescriben, no', async () => {
    await world.tenantDb.run(ctx, async (tx) => {
      await tx.execute(`UPDATE core.organizations SET timezone = 'America/Hermosillo'` as never);
    });
    expect(await world.branches.getEffectiveTimezone(ctx, branchIds.VEN!)).toBe('America/Hermosillo');
    expect(await world.branches.getEffectiveTimezone(ctx, branchIds.SMA!)).toBe('America/Mexico_City');
  });

  it('quitar la sobrescritura (null) vuelve a heredar; una zona inválida se rechaza y queda sin cambios', async () => {
    await world.branches.update(ctx, branchIds.SMA!, { timezone: null });
    expect(await world.branches.getEffectiveTimezone(ctx, branchIds.SMA!)).toBe('America/Hermosillo');
    await expect(world.branches.update(ctx, branchIds.SMA!, { timezone: 'Nope/Nada' })).rejects.toMatchObject({ code: 'TIMEZONE_INVALID' });
    await expect(world.branches.create(ctx, { code: 'NEW', name: 'Nueva', timezone: 'EST' })).rejects.toMatchObject({ code: 'TIMEZONE_INVALID' });
  });
});

describe('UTC en base de datos', () => {
  it('los instantes se guardan en UTC sin importar la zona de la sesión ni del negocio', async () => {
    const c = await pools.superuser.connect();
    try {
      await c.query(`SET TIME ZONE 'America/Tijuana'`);
      const { rows } = await c.query(`SELECT TIMESTAMPTZ '2030-03-09 23:30:00-08' AT TIME ZONE 'UTC' AS utc, TIMESTAMPTZ '2030-03-09 23:30:00-08' = TIMESTAMPTZ '2030-03-10 07:30:00+00' AS same`);
      expect(rows[0].same).toBe(true);
      expect(new Date(rows[0].utc + 'Z').toISOString()).toBe('2030-03-10T07:30:00.000Z');
    } finally {
      c.release();
    }
    const dbTz = (await pools.app.query('SHOW timezone')).rows[0].TimeZone;
    expect(dbTz).toBe('UTC');
  });
});

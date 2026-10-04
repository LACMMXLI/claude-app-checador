import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { count, asTenant, pgError } from './helpers/sql.js';
import { PASSWORD, buildWorld, openPools, uniq } from './helpers/world.js';

/**
 * Fase 5 (D-83…D-89) · Planes y suscripciones en PostgreSQL: valores semilla, sincronía con el estado del negocio, historial
 * inmutable, aislamiento del plano de plataforma y límites del plan como última línea de defensa.
 */
const pools = openPools();
const world = buildWorld(pools);
afterAll(() => pools.close());

const created: string[] = [];
async function org(opts: { plan?: string; status?: 'TRIAL' | 'ACTIVE'; trialEndsAt?: Date } = {}) {
  const slug = uniq('sub');
  const subscription = opts.plan
    ? { planCode: opts.plan, status: opts.status ?? ('ACTIVE' as const), trialEndsAt: opts.trialEndsAt }
    : undefined;
  const r = await world.platformAdmin.createOrganization({
    name: `Negocio ${slug}`,
    slug,
    timezone: 'America/Tijuana',
    branches: [{ code: 'A', name: 'Sucursal A' }],
    admin: { email: `${slug}@ejemplo.com`, displayName: 'Admin', password: PASSWORD },
    subscription,
  }, 'prueba:operador');
  created.push(slug);
  return { ...r, slug };
}

/** Plan de prueba con límites mínimos (se desactiva al terminar para no ensuciar el catálogo). */
async function tinyPlan(limits: Partial<Record<'max_branches' | 'max_employees' | 'max_kiosks' | 'max_members', number | null>> = {}) {
  const code = `T_${randomUUID().slice(0, 8).toUpperCase()}`;
  const l = { max_branches: 1, max_employees: 1, max_kiosks: 1, max_members: 1, ...limits };
  await pools.superuser.query(
    `INSERT INTO platform.plans (code, name, max_branches, max_employees, max_kiosks, max_members, features, is_active)
     VALUES ($1, 'Plan de prueba', $2, $3, $4, $5, '{}', false)`,
    [code, l.max_branches, l.max_employees, l.max_kiosks, l.max_members],
  );
  return code;
}
const setPlan = (orgId: string, plan: string) => pools.platform.query('UPDATE platform.subscriptions SET plan_code = $2 WHERE organization_id = $1', [orgId, plan]);

describe('catálogo, valores semilla y estructura', () => {
  it('hay exactamente dos planes semilla: BASIC y ADVANCED, con límites y funciones distintos', async () => {
    const { rows } = await pools.superuser.query(`SELECT * FROM platform.plans WHERE code IN ('BASIC','ADVANCED') ORDER BY sort_order`);
    expect(rows.map((r) => r.code)).toEqual(['BASIC', 'ADVANCED']);
    const [basic, advanced] = rows;
    expect([basic.max_branches, basic.max_employees, basic.max_kiosks, basic.max_members]).toEqual([2, 25, 2, 3]);
    expect([advanced.max_branches, advanced.max_employees, advanced.max_kiosks, advanced.max_members]).toEqual([10, 250, 20, 25]);
    expect(basic.features).toEqual({ reportsExport: false, scheduleTemplates: false });
    expect(advanced.features).toEqual({ reportsExport: true, scheduleTemplates: true });
  });

  it('las tablas de plataforma son invisibles para app_user (sin privilegios); el negocio solo ve su plan por la función-puerta', async () => {
    for (const t of ['plans', 'subscriptions', 'subscription_events', 'operators', 'operator_sessions']) {
      await asTenant(pools.app, null, async (c) => {
        expect((await pgError(c, `SELECT 1 FROM platform.${t} LIMIT 1`))?.code, t).toBe('42501');
      });
    }
  });
});

describe('suscripción inicial (D-89) y estado del negocio (D-84)', () => {
  it('un negocio creado sin indicar suscripción queda ADVANCED/ACTIVE y con su evento CREATED', async () => {
    const a = await org();
    const sub = (await pools.superuser.query('SELECT * FROM platform.subscriptions WHERE organization_id = $1', [a.organizationId])).rows[0];
    expect([sub.plan_code, sub.status, sub.trial_ends_at, sub.current_period_end]).toEqual(['ADVANCED', 'ACTIVE', null, null]);
    const events = (await pools.superuser.query('SELECT event, to_plan, to_status, actor FROM platform.subscription_events WHERE organization_id = $1', [a.organizationId])).rows;
    expect(events).toEqual([{ event: 'CREATED', to_plan: 'ADVANCED', to_status: 'ACTIVE', actor: expect.any(String) }]);
  });

  it('la suscripción indicada al crear se aplica en la misma transacción (BASIC en prueba con vencimiento) y el historial nombra al operador', async () => {
    const end = new Date(Date.now() + 14 * 86_400_000);
    const b = await org({ plan: 'BASIC', status: 'TRIAL', trialEndsAt: end });
    const sub = (await pools.superuser.query('SELECT * FROM platform.subscriptions WHERE organization_id = $1', [b.organizationId])).rows[0];
    expect([sub.plan_code, sub.status]).toEqual(['BASIC', 'TRIAL']);
    expect(new Date(sub.trial_ends_at).getTime()).toBe(end.getTime());
    const events = (await pools.superuser.query(`SELECT event, actor FROM platform.subscription_events WHERE organization_id = $1 ORDER BY id`, [b.organizationId])).rows;
    expect(events.map((e) => e.event)).toEqual(['CREATED', 'PLAN_CHANGED', 'STATUS_CHANGED', 'PERIOD_CHANGED']);
    expect(new Set(events.map((e) => e.actor))).toEqual(new Set(['prueba:operador']));
  });

  it('un plan inexistente o inactivo no se puede asignar y no deja ningún negocio a medias', async () => {
    const slug = uniq('sub-bad');
    const input = (planCode: string) => ({
      name: slug, slug, timezone: 'America/Tijuana', admin: { email: `${slug}@ejemplo.com`, displayName: 'A', password: PASSWORD },
      subscription: { planCode, status: 'ACTIVE' as const },
    });
    await expect(world.platformAdmin.createOrganization(input('NO_EXISTE'))).rejects.toThrow(/PLAN_NOT_FOUND/);
    await expect(world.platformAdmin.createOrganization(input(await tinyPlan()))).rejects.toThrow(/PLAN_NOT_ACTIVE/);
    expect(await count(pools.superuser, 'SELECT count(*) FROM core.organizations WHERE slug = $1', [slug])).toBe(0);
  });

  it('el estado del negocio sigue a la suscripción: SUSPENDED/EXPIRED/CANCELLED suspenden; TRIAL/ACTIVE operan', async () => {
    const a = await org();
    const status = async () => (await pools.superuser.query('SELECT status FROM core.organizations WHERE id = $1', [a.organizationId])).rows[0].status;
    const set = (s: string) => pools.platform.query(`UPDATE platform.subscriptions SET status = $2, trial_ends_at = CASE WHEN $2 = 'TRIAL' THEN now() + interval '1 day' ELSE trial_ends_at END WHERE organization_id = $1`, [a.organizationId, s]);
    for (const [s, expected] of [['SUSPENDED', 'SUSPENDED'], ['ACTIVE', 'ACTIVE'], ['EXPIRED', 'SUSPENDED'], ['TRIAL', 'ACTIVE'], ['CANCELLED', 'SUSPENDED'], ['ACTIVE', 'ACTIVE']] as const) {
      await set(s);
      expect(await status(), s).toBe(expected);
    }
  });

  it('suspender deja al negocio fuera de las funciones-puerta (inicio de sesión) sin borrar ningún dato', async () => {
    const a = await org();
    const before = await asTenant(pools.app, a.organizationId, async (c) => count(c, 'SELECT count(*) FROM core.branches'));
    await pools.platform.query(`UPDATE platform.subscriptions SET status = 'SUSPENDED' WHERE organization_id = $1`, [a.organizationId]);
    const memberships = await asTenant(pools.app, null, async (c) => (await c.query(`SELECT 1 FROM auth.list_user_memberships()`)).rowCount, a.adminUserId);
    expect(memberships).toBe(0);
    await pools.platform.query(`UPDATE platform.subscriptions SET status = 'ACTIVE' WHERE organization_id = $1`, [a.organizationId]);
    expect(await count(pools.superuser, 'SELECT count(*) FROM core.branches WHERE organization_id = $1', [a.organizationId])).toBe(before);
  });

  it('el CLI set-status mueve la suscripción (y el trigger, el negocio): no queda un estado contradictorio', async () => {
    const a = await org();
    await world.platformAdmin.setOrganizationStatus(a.slug, 'SUSPENDED', 'prueba:cli');
    const row = (await pools.superuser.query(`SELECT s.status AS sub, o.status AS org FROM platform.subscriptions s JOIN core.organizations o ON o.id = s.organization_id WHERE o.id = $1`, [a.organizationId])).rows[0];
    expect(row).toEqual({ sub: 'SUSPENDED', org: 'SUSPENDED' });
    await world.platformAdmin.setOrganizationStatus(a.slug, 'ACTIVE', 'prueba:cli');
    expect((await pools.superuser.query('SELECT status FROM core.organizations WHERE id = $1', [a.organizationId])).rows[0].status).toBe('ACTIVE');
  });
});

describe('historial inmutable (D-85)', () => {
  it('cada cambio deja su evento con el responsable y el historial no se puede editar ni borrar', async () => {
    const a = await org();
    const client = await pools.platform.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.platform_actor', 'operador:ana', true)`);
      await client.query(`UPDATE platform.subscriptions SET plan_code = 'BASIC', status = 'SUSPENDED', notes = 'cliente pidió pausa' WHERE organization_id = $1`, [a.organizationId]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const events = (await pools.superuser.query(`SELECT event, from_plan, to_plan, from_status, to_status, actor, details FROM platform.subscription_events WHERE organization_id = $1 ORDER BY id`, [a.organizationId])).rows;
    expect(events.map((e) => e.event)).toEqual(['CREATED', 'PLAN_CHANGED', 'STATUS_CHANGED', 'NOTES_CHANGED']);
    expect(events[1]).toMatchObject({ from_plan: 'ADVANCED', to_plan: 'BASIC', actor: 'operador:ana' });
    expect(events[2]).toMatchObject({ from_status: 'ACTIVE', to_status: 'SUSPENDED', actor: 'operador:ana' });
    expect(JSON.stringify(events[3].details)).not.toContain('pausa'); // las notas no se copian al historial

    for (const sql of ['UPDATE platform.subscription_events SET actor = \'x\'', 'DELETE FROM platform.subscription_events', 'TRUNCATE platform.subscription_events']) {
      await expect(pools.platform.query(sql), sql).rejects.toMatchObject({ code: '42501' });
    }
    await expect(pools.superuser.query('UPDATE platform.subscription_events SET actor = \'x\'')).rejects.toThrow(/solo-agregar/);
  });
});

describe('función-puerta core.current_entitlements (D-87)', () => {
  it('cada negocio ve SOLO su plan (nunca el de otro) y sin datos internos', async () => {
    const basic = await org({ plan: 'BASIC', status: 'ACTIVE' });
    const advanced = await org({ plan: 'ADVANCED', status: 'ACTIVE' });
    await pools.platform.query(`UPDATE platform.subscriptions SET notes = 'solo para operadores' WHERE organization_id = $1`, [basic.organizationId]);
    const mine = await asTenant(pools.app, basic.organizationId, async (c) => (await c.query('SELECT * FROM core.current_entitlements()')).rows);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ plan_code: 'BASIC', subscription_status: 'ACTIVE', max_branches: 2, max_employees: 25 });
    expect(JSON.stringify(mine)).not.toContain('operadores');
    const theirs = await asTenant(pools.app, advanced.organizationId, async (c) => (await c.query('SELECT plan_code FROM core.current_entitlements()')).rows);
    expect(theirs).toEqual([{ plan_code: 'ADVANCED' }]);
    // sin contexto de negocio: nada
    expect(await asTenant(pools.app, null, async (c) => (await c.query('SELECT * FROM core.current_entitlements()')).rowCount)).toBe(0);
  });
});

describe('límites del plan en PostgreSQL (D-86)', () => {
  const insertBranch = (c: Parameters<Parameters<typeof asTenant>[2]>[0], orgId: string, code: string) =>
    pgError(c, `INSERT INTO core.branches (organization_id, code, name) VALUES ($1, $2, $2)`, [orgId, code]);

  it('sucursales: se rechaza la que excede el cupo, desactivar libera lugar y reactivar por encima se rechaza', async () => {
    const a = await org({ plan: 'BASIC', status: 'ACTIVE' }); // BASIC: 2 sucursales; ya existe A
    await asTenant(pools.app, a.organizationId, async (c) => {
      expect(await insertBranch(c, a.organizationId, 'B')).toBeNull();
      const err = await insertBranch(c, a.organizationId, 'C');
      expect(err?.message).toBe('PLAN_LIMIT_BRANCHES');
      expect(err?.code).toBe('P0001');
      // desactivar libera cupo
      await c.query(`UPDATE core.branches SET is_active = false WHERE organization_id = $1 AND code = 'B'`, [a.organizationId]);
      expect(await insertBranch(c, a.organizationId, 'C')).toBeNull();
      // reactivar B ahora excedería el límite
      expect((await pgError(c, `UPDATE core.branches SET is_active = true WHERE organization_id = $1 AND code = 'B'`, [a.organizationId]))?.message).toBe('PLAN_LIMIT_BRANCHES');
    });
  });

  it('empleados, kioscos y usuarios activos tienen su propio cupo', async () => {
    const plan = await tinyPlan({ max_branches: 5, max_employees: 1, max_kiosks: 1, max_members: 2 });
    const a = await org();
    await setPlan(a.organizationId, plan);
    const branchA = a.branchIds.A!;
    // el administrador ya ocupa 1 de 2 usuarios
    const u2 = (await pools.superuser.query(`INSERT INTO auth.users (email, display_name) VALUES ($1, 'Otro') RETURNING id`, [`${uniq('u')}@ejemplo.com`])).rows[0].id;
    const u3 = (await pools.superuser.query(`INSERT INTO auth.users (email, display_name) VALUES ($1, 'Otro 2') RETURNING id`, [`${uniq('u')}@ejemplo.com`])).rows[0].id;
    await asTenant(pools.app, a.organizationId, async (c) => {
      expect(await pgError(c, `INSERT INTO core.employees (organization_id, employee_number, first_name) VALUES ($1, '1', 'Uno')`, [a.organizationId])).toBeNull();
      expect((await pgError(c, `INSERT INTO core.employees (organization_id, employee_number, first_name) VALUES ($1, '2', 'Dos')`, [a.organizationId]))?.message).toBe('PLAN_LIMIT_EMPLOYEES');
      expect(await pgError(c, `INSERT INTO core.kiosk_devices (organization_id, branch_id, name) VALUES ($1, $2, 'K1')`, [a.organizationId, branchA])).toBeNull();
      expect((await pgError(c, `INSERT INTO core.kiosk_devices (organization_id, branch_id, name) VALUES ($1, $2, 'K2')`, [a.organizationId, branchA]))?.message).toBe('PLAN_LIMIT_KIOSKS');
      expect(await pgError(c, `INSERT INTO core.organization_memberships (organization_id, user_id) VALUES ($1, $2)`, [a.organizationId, u2])).toBeNull();
      expect((await pgError(c, `INSERT INTO core.organization_memberships (organization_id, user_id) VALUES ($1, $2)`, [a.organizationId, u3]))?.message).toBe('PLAN_LIMIT_MEMBERS');
    });
  });

  it('un plan sin límite (NULL) no restringe', async () => {
    const plan = await tinyPlan({ max_branches: null });
    const a = await org();
    await setPlan(a.organizationId, plan);
    await asTenant(pools.app, a.organizationId, async (c) => {
      for (const code of ['B', 'C', 'D', 'E']) expect(await insertBranch(c, a.organizationId, code)).toBeNull();
    });
  });

  it('bajar de plan NO borra ni desactiva nada: solo impide crear por encima del nuevo límite', async () => {
    const a = await org({ plan: 'ADVANCED', status: 'ACTIVE' });
    for (const code of ['B', 'C', 'D']) await pools.platform.query(`INSERT INTO core.branches (organization_id, code, name) VALUES ($1, $2, $2)`, [a.organizationId, code]);
    await setPlan(a.organizationId, 'BASIC'); // BASIC permite 2
    expect(await count(pools.superuser, 'SELECT count(*) FROM core.branches WHERE organization_id = $1 AND is_active', [a.organizationId])).toBe(4);
    await asTenant(pools.app, a.organizationId, async (c) => {
      expect((await insertBranch(c, a.organizationId, 'E'))?.message).toBe('PLAN_LIMIT_BRANCHES');
      // editar una sucursal ya activa no cuenta como alta nueva
      expect(await pgError(c, `UPDATE core.branches SET name = 'Renombrada' WHERE organization_id = $1 AND code = 'B'`, [a.organizationId])).toBeNull();
    });
  });

  it('la plataforma (platform_ops) puede exceder el límite por decisión operativa; el límite aplica solo al tráfico de app_user', async () => {
    const a = await org({ plan: 'BASIC', status: 'ACTIVE' });
    for (const code of ['B', 'C', 'D']) await pools.platform.query(`INSERT INTO core.branches (organization_id, code, name) VALUES ($1, $2, $2)`, [a.organizationId, code]);
    expect(await count(pools.superuser, 'SELECT count(*) FROM core.branches WHERE organization_id = $1', [a.organizationId])).toBe(4);
  });

  it('el límite de un negocio nunca se cuenta con los datos de otro', async () => {
    const small = await org({ plan: 'BASIC', status: 'ACTIVE' });
    const big = await org({ plan: 'ADVANCED', status: 'ACTIVE' });
    for (const code of ['B', 'C', 'D']) await pools.platform.query(`INSERT INTO core.branches (organization_id, code, name) VALUES ($1, $2, $2)`, [big.organizationId, code]);
    await asTenant(pools.app, small.organizationId, async (c) => {
      expect(await insertBranch(c, small.organizationId, 'B')).toBeNull(); // la otra tiene 4, esta solo 1
    });
  });
});

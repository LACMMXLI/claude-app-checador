import { afterAll, describe, expect, it } from 'vitest';
import { PASSWORD, buildWorld, makeClock, openPools, uniq } from './helpers/world.js';

/** D-84 … D-88 · Clientes y suscripciones: alta, ciclo de vida, vencimientos, historial y planes. */
const pools = openPools();
const clock = makeClock();
const world = buildWorld(pools, clock.now);
afterAll(() => pools.close());
const ACTOR = 'operator:ana@plataforma.example';

const newCustomer = (extra: Record<string, unknown> = {}, mode: 'TRIAL' | 'ACTIVE' = 'TRIAL', planCode = 'BASIC') => {
  const slug = uniq('cli');
  return world.customers.create({
    name: `Cliente ${slug}`, slug, timezone: 'America/Tijuana',
    branches: [{ code: 'A', name: 'Centro' }],
    admin: { email: `${slug}@ejemplo.com`, displayName: 'Dueña' },
    subscription: mode === 'TRIAL' ? { mode, planCode, trialDays: 14 } : { mode, planCode, currentPeriodEnd: null },
    ...extra,
  }, ACTOR).then((r) => ({ ...r, slug }));
};
const status = async (id: string) => (await pools.superuser.query('SELECT s.status AS sub, o.status AS org FROM platform.subscriptions s JOIN core.organizations o ON o.id = s.organization_id WHERE o.id = $1', [id])).rows[0];

describe('alta de un cliente (D-88)', () => {
  it('crea negocio + sucursales + administrador + suscripción en una transacción y devuelve la contraseña inicial UNA vez', async () => {
    const c = await newCustomer();
    expect(c.admin.createdUser).toBe(true);
    expect(c.admin.initialPassword).toHaveLength(16);
    const detail = await world.customers.get(c.organizationId);
    expect(detail).toMatchObject({ slug: c.slug, planCode: 'BASIC', status: 'TRIAL', organizationStatus: 'ACTIVE', adminEmail: `${c.slug}@ejemplo.com` });
    expect(detail.branches.map((b) => b.code)).toEqual(['A']);
    expect(detail.admins).toEqual([{ email: `${c.slug}@ejemplo.com`, displayName: 'Dueña', status: 'ACTIVE' }]);
    expect(detail.daysLeft).toBe(14);
    expect(detail.limits).toEqual({ branches: 2, employees: 25, kiosks: 2, members: 3 });
    // la contraseña generada no queda en ninguna bitácora ni en el historial
    const everywhere = JSON.stringify([
      (await pools.superuser.query('SELECT details FROM platform.platform_audit_log WHERE organization_id = $1', [c.organizationId])).rows,
      (await pools.superuser.query('SELECT details FROM platform.subscription_events WHERE organization_id = $1', [c.organizationId])).rows,
      (await pools.superuser.query('SELECT after, reason FROM audit.audit_log WHERE organization_id = $1', [c.organizationId])).rows,
    ]);
    expect(everywhere).not.toContain(c.admin.initialPassword);
  });

  it('el administrador puede entrar de inmediato con esa contraseña (la identidad quedó bien creada)', async () => {
    const c = await newCustomer();
    const { rows } = await pools.app.query(`SELECT 1 FROM auth.get_login_record($1)`, [`${c.slug}@ejemplo.com`]);
    expect(rows).toHaveLength(1);
  });

  it('con una contraseña escrita por el operador no se devuelve ninguna; si el correo ya existe se reutiliza la identidad sin tocar su contraseña', async () => {
    const first = await newCustomer({ admin: { email: `${uniq('dueno')}@ejemplo.com`, displayName: 'Dueño', password: PASSWORD } });
    expect(first.admin.initialPassword).toBeNull();
    const email = `${uniq('compartido')}@ejemplo.com`;
    const a = await newCustomer({ admin: { email, displayName: 'Persona' } });
    expect(a.admin.createdUser).toBe(true);
    const b = await newCustomer({ admin: { email, displayName: 'Persona' } });
    expect(b.admin).toMatchObject({ createdUser: false, initialPassword: null });
  });

  it('valida: zona horaria obligatoria, al menos una sucursal, plan existente/activo y sucursales dentro del límite del plan', async () => {
    await expect(newCustomer({ timezone: undefined })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(newCustomer({ timezone: 'Marte/Olimpo' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(newCustomer({ branches: [] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(newCustomer({}, 'TRIAL', 'NO_EXISTE')).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
    const three = [{ code: 'A', name: 'A' }, { code: 'B', name: 'B' }, { code: 'C', name: 'C' }];
    await expect(newCustomer({ branches: three })).rejects.toMatchObject({ code: 'PLAN_LIMIT_BRANCHES', details: { limit: 2, requested: 3 } });
    expect((await newCustomer({ branches: three }, 'ACTIVE', 'ADVANCED')).organizationId).toBeTruthy();
    const slug = uniq('dup');
    await newCustomer({ slug });
    await expect(newCustomer({ slug })).rejects.toMatchObject({ code: 'ORGANIZATION_SLUG_TAKEN' });
  });
});

describe('ciclo de vida de la suscripción (D-84)', () => {
  it('suspender / reactivar / cancelar mueven el estado del negocio; nada se borra; cada paso queda en historial y bitácora', async () => {
    const c = await newCustomer({}, 'ACTIVE', 'ADVANCED');
    const id = c.organizationId;
    await world.subscriptions.suspend(id, 'Pidió pausa', ACTOR);
    expect(await status(id)).toEqual({ sub: 'SUSPENDED', org: 'SUSPENDED' });
    await expect(world.subscriptions.suspend(id, 'otra vez', ACTOR)).rejects.toMatchObject({ code: 'SUBSCRIPTION_STATE_INVALID' });
    await world.subscriptions.activate(id, { currentPeriodEnd: null }, ACTOR);
    expect(await status(id)).toEqual({ sub: 'ACTIVE', org: 'ACTIVE' });
    await world.subscriptions.cancel(id, 'Se dio de baja', ACTOR);
    expect(await status(id)).toEqual({ sub: 'CANCELLED', org: 'SUSPENDED' });
    await expect(world.subscriptions.cancel(id, 'otra vez', ACTOR)).rejects.toMatchObject({ code: 'SUBSCRIPTION_STATE_INVALID' });
    await world.subscriptions.activate(id, { currentPeriodEnd: null }, ACTOR); // reactivar tras cancelar
    expect(await status(id)).toEqual({ sub: 'ACTIVE', org: 'ACTIVE' });

    const events = await world.subscriptions.events(id);
    expect(events.map((e) => e.event).reverse()).toEqual(['CREATED', 'STATUS_CHANGED', 'STATUS_CHANGED', 'STATUS_CHANGED', 'STATUS_CHANGED']);
    expect(new Set(events.slice(0, 4).map((e) => e.actor))).toEqual(new Set([ACTOR]));
    const audit = await world.audit.list({ organizationId: id });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['subscription.suspended', 'subscription.activated', 'subscription.cancelled']));
    expect(JSON.stringify(audit.find((a) => a.action === 'subscription.suspended')!.details)).toContain('Pidió pausa');
    expect(await pools.superuser.query('SELECT count(*)::int AS n FROM core.branches WHERE organization_id = $1', [id])).toMatchObject({ rows: [{ n: 1 }] });
  });

  it('cambiar de plan avisa (sin tocar datos) cuando el negocio ya excede el nuevo plan; el mismo plan o uno inactivo se rechazan', async () => {
    const c = await newCustomer({ branches: [{ code: 'A', name: 'A' }, { code: 'B', name: 'B' }, { code: 'C', name: 'C' }] }, 'ACTIVE', 'ADVANCED');
    const up = await world.subscriptions.changePlan(c.organizationId, 'BASIC', ACTOR);
    expect(up.subscription.planCode).toBe('BASIC');
    expect(up.warnings).toEqual([{ resource: 'branches', limit: 2, used: 3 }]);
    expect((await world.customers.get(c.organizationId)).usage.branches).toBe(3); // nada se desactivó
    await expect(world.subscriptions.changePlan(c.organizationId, 'BASIC', ACTOR)).rejects.toMatchObject({ code: 'PLAN_UNCHANGED' });
    await expect(world.subscriptions.changePlan(c.organizationId, 'NO_EXISTE', ACTOR)).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
    expect((await world.subscriptions.changePlan(c.organizationId, 'ADVANCED', ACTOR)).warnings).toEqual([]);
  });

  it('prueba y vigencia: iniciar prueba, extender, y vencer con el barrido (idempotente) que suspende al negocio', async () => {
    const c = await newCustomer({}, 'TRIAL');
    const id = c.organizationId;
    expect((await world.subscriptions.get(id)).daysLeft).toBe(14);
    await world.subscriptions.extend(id, new Date(clock.now().getTime() + 30 * 86_400_000), ACTOR);
    expect((await world.subscriptions.get(id)).daysLeft).toBe(30);
    await expect(world.subscriptions.extend(id, new Date(2000, 0, 1), ACTOR)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); // la vigencia debe ser futura
    await expect(world.subscriptions.activate(id, { currentPeriodEnd: new Date(2000, 0, 1) }, ACTOR)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(await world.subscriptions.expireDue()).not.toContain(id); // aún vigente
    clock.advance(31 * 86_400_000);
    const sub = await world.subscriptions.get(id);
    expect([sub.status, sub.effectiveStatus]).toEqual(['TRIAL', 'EXPIRED']); // el cliente ya lo ve vencido aunque no se haya barrido
    expect(await world.subscriptions.expireDue()).toContain(id);
    expect(await status(id)).toEqual({ sub: 'EXPIRED', org: 'SUSPENDED' });
    expect(await world.subscriptions.expireDue()).not.toContain(id); // idempotente
    await expect(world.subscriptions.extend(id, new Date(clock.now().getTime() + 86_400_000), ACTOR)).rejects.toMatchObject({ code: 'SUBSCRIPTION_STATE_INVALID' });
    // renovar la vigencia lo reactiva
    await world.subscriptions.activate(id, { currentPeriodEnd: new Date(clock.now().getTime() + 90 * 86_400_000) }, ACTOR);
    expect(await status(id)).toEqual({ sub: 'ACTIVE', org: 'ACTIVE' });
    const events = (await world.subscriptions.events(id)).map((e) => `${e.event}:${e.actor}`);
    expect(events).toContain('STATUS_CHANGED:system:sweeper');
    // ACTIVE con vigencia que vence → también expira
    clock.advance(91 * 86_400_000);
    expect(await world.subscriptions.expireDue()).toContain(id);
  });

  it('startTrial reinicia la prueba con el plan indicado; las notas internas no se copian al historial', async () => {
    const c = await newCustomer({}, 'ACTIVE', 'BASIC');
    const r = await world.subscriptions.startTrial(c.organizationId, { days: 7, planCode: 'ADVANCED' }, ACTOR);
    expect([r.subscription.status, r.subscription.planCode, r.subscription.daysLeft]).toEqual(['TRIAL', 'ADVANCED', 7]);
    await world.subscriptions.setNotes(c.organizationId, 'secreto interno del contrato', ACTOR);
    expect(JSON.stringify(await world.subscriptions.events(c.organizationId))).not.toContain('secreto');
    expect(JSON.stringify(await world.audit.list({ organizationId: c.organizationId }))).not.toContain('secreto');
    expect((await world.customers.get(c.organizationId)).notes).toBe('secreto interno del contrato');
  });
});

describe('lista, búsqueda y resumen', () => {
  it('filtra por texto, estado y plan; pagina con total', async () => {
    const tag = uniq('zzfiltro');
    const a = await newCustomer({ name: `Taquería ${tag}` }, 'ACTIVE', 'ADVANCED');
    const b = await newCustomer({ name: `Cafetería ${tag}` }, 'TRIAL', 'BASIC');
    await world.subscriptions.suspend(b.organizationId, 'prueba', ACTOR);
    const all = await world.customers.list({ q: tag, limit: 50, offset: 0 });
    expect(all.total).toBe(2);
    expect((await world.customers.list({ q: tag, status: 'SUSPENDED', limit: 50, offset: 0 })).items.map((i) => i.id)).toEqual([b.organizationId]);
    expect((await world.customers.list({ q: tag, plan: 'ADVANCED', limit: 50, offset: 0 })).items.map((i) => i.id)).toEqual([a.organizationId]);
    const page = await world.customers.list({ q: tag, limit: 1, offset: 1 });
    expect([page.total, page.items.length]).toEqual([2, 1]);
    // el comodín % no es un comodín
    expect((await world.customers.list({ q: '%', limit: 5, offset: 0 })).total).toBe(0);
    expect((await world.customers.list({ q: `${a.slug}@`.slice(0, 6), limit: 5, offset: 0 })).total).toBeGreaterThanOrEqual(1); // por correo del admin
  });

  it('el resumen cuenta clientes por estado y plan y avisa de los que vencen pronto', async () => {
    const c = await newCustomer({}, 'TRIAL');
    await world.subscriptions.extend(c.organizationId, new Date(clock.now().getTime() + 3 * 86_400_000), ACTOR);
    const d = await world.dashboard.get();
    expect(d.totals.customers).toBeGreaterThanOrEqual(1);
    expect(d.byPlan.map((p) => p.planCode)).toEqual(expect.arrayContaining(['BASIC', 'ADVANCED']));
    expect(d.expiringSoon.map((e) => e.id)).toContain(c.organizationId);
    expect(d.recent.length).toBeGreaterThan(0);
  });
});

describe('planes (D-83)', () => {
  it('el operador edita límites y funciones; el cliente los ve de inmediato; un plan inactivo no se asigna y no se puede dejar sin planes activos', async () => {
    const c = await newCustomer({}, 'ACTIVE', 'BASIC');
    const before = await pools.app.connect();
    try {
      await before.query('BEGIN');
      await before.query(`SELECT set_config('app.organization_id', $1, true)`, [c.organizationId]);
      expect((await before.query('SELECT max_employees FROM core.current_entitlements()')).rows[0].max_employees).toBe(25);
      await before.query('ROLLBACK');
    } finally {
      before.release();
    }
    await world.plans.update('BASIC', { limits: { employees: 40 }, features: { reportsExport: true } }, ACTOR);
    const client = await pools.app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.organization_id', $1, true)`, [c.organizationId]);
      const row = (await client.query('SELECT max_employees, features FROM core.current_entitlements()')).rows[0];
      expect([row.max_employees, row.features.reportsExport]).toEqual([40, true]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await world.plans.update('BASIC', { limits: { employees: 25 }, features: { reportsExport: false } }, ACTOR); // restaurar
    await expect(world.plans.update('BASIC', { limits: { employees: 0 as never } }, ACTOR)).rejects.toBeTruthy();
    await expect(world.plans.update('NO_EXISTE', { name: 'x' }, ACTOR)).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
    await expect(world.plans.update('BASIC', {}, ACTOR)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await pools.superuser.query(`INSERT INTO platform.plans (code, name, max_branches, is_active) VALUES ('T_OFF', 'Apagado', 1, false) ON CONFLICT DO NOTHING`);
    await expect(world.subscriptions.changePlan(c.organizationId, 'T_OFF', ACTOR)).rejects.toMatchObject({ code: 'PLAN_NOT_ACTIVE' });
    // desactivar dejaría un solo plan activo → se permite; el último activo, no
    await world.plans.update('BASIC', { isActive: false }, ACTOR);
    await expect(world.plans.update('ADVANCED', { isActive: false }, ACTOR)).rejects.toMatchObject({ code: 'LAST_ACTIVE_PLAN' });
    await world.plans.update('BASIC', { isActive: true }, ACTOR);
    const list = await world.plans.list();
    expect(list.find((p) => p.code === 'BASIC')!.customers).toBeGreaterThanOrEqual(1);
    const audit = (await world.audit.list({ limit: 200 })).filter((a) => a.action === 'plan.updated');
    expect(audit.length).toBeGreaterThanOrEqual(3);
  });
});

describe('soporte', () => {
  it('restablecer la contraseña de un usuario: devuelve una nueva una vez y la bitácora no la guarda; usuario inexistente → USER_NOT_FOUND', async () => {
    const c = await newCustomer();
    const email = `${c.slug}@ejemplo.com`;
    const { password } = await world.support.resetUserPassword(email, ACTOR);
    expect(password).toHaveLength(16);
    expect(password).not.toBe(c.admin.initialPassword);
    expect(JSON.stringify((await pools.superuser.query(`SELECT details FROM platform.platform_audit_log WHERE action = 'user.password_reset'`)).rows)).not.toContain(password);
    await expect(world.support.resetUserPassword('nadie@ejemplo.com', ACTOR)).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });
});

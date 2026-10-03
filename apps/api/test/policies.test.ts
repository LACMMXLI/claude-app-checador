import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EffectivePolicy, resolvePolicy, validateOverride } from '../src/modules/policies/policy.js';
import { pgError } from './helpers/sql.js';
import { PASSWORD, buildWorld, openPools, uniq, userCtx } from './helpers/world.js';

const PLATFORM: EffectivePolicy = {
  entryToleranceMin: 10, exitToleranceMin: 0, maxBreaks: 1, breakAllowedMin: 35, breakToleranceMin: 0, requireBreak: false,
  earlyEntryWindowMin: 60, absentAfterMin: 60, operationalCutoff: '05:00:00', maxOpenSessionMinutes: 960, debounceSec: 60,
  pinMaxAttempts: 5, pinLockoutSec: 10, pinLockoutMaxSec: 120, weekStartDay: 1, shiftMinMinutes: 60, shiftMaxMinutes: 960,
  breakRequiredAfterMin: 0, correctionRequestWindowDays: 7, maxPendingCorrectionRequests: 3,
};

describe('política efectiva (función pura)', () => {
  it('ejemplo Fatboy: comida 35 · San Marcos hereda · Venecia 40 · empleado X en Venecia 30', () => {
    const fatboy = { breakAllowedMin: 35 };
    const venecia = { breakAllowedMin: 40 };
    const empleadoX = { breakAllowedMin: 30 };
    expect(resolvePolicy(PLATFORM, { organization: fatboy, branch: undefined }).policy.breakAllowedMin).toBe(35);           // San Marcos hereda
    expect(resolvePolicy(PLATFORM, { organization: fatboy, branch: venecia }).policy.breakAllowedMin).toBe(40);             // Venecia
    expect(resolvePolicy(PLATFORM, { organization: fatboy, branch: venecia, employee: empleadoX }).policy.breakAllowedMin).toBe(30); // empleado X
    expect(resolvePolicy(PLATFORM, { organization: fatboy, branch: venecia, employee: {} }).policy.breakAllowedMin).toBe(40);  // otro empleado de Venecia
  });

  it('sin overrides devuelve la política de plataforma; null/undefined heredan; el más específico gana parámetro por parámetro', () => {
    expect(resolvePolicy(PLATFORM, {}).policy).toEqual(PLATFORM);
    const r = resolvePolicy(PLATFORM, {
      organization: { entryToleranceMin: 15, operationalCutoff: '04:00:00' },
      branch: { entryToleranceMin: null, operationalCutoff: '06:00:00', earlyEntryWindowMin: 90 },
      employee: { exitToleranceMin: 5 },
    });
    expect(r.policy).toMatchObject({ entryToleranceMin: 15, operationalCutoff: '06:00:00', earlyEntryWindowMin: 90, exitToleranceMin: 5, breakAllowedMin: 35 });
    expect(r.sources).toMatchObject({ entryToleranceMin: 'ORGANIZATION', operationalCutoff: 'BRANCH', earlyEntryWindowMin: 'BRANCH', exitToleranceMin: 'EMPLOYEE', breakAllowedMin: 'PLATFORM' });
  });

  it('valida valores y niveles permitidos (tolerancia, entrada anticipada, pausas, corte operativo, ...)', () => {
    expect(validateOverride('EMPLOYEE', { breakAllowedMin: 30, entryToleranceMin: 5, maxBreaks: 2 })).toEqual({ breakAllowedMin: 30, entryToleranceMin: 5, maxBreaks: 2 });
    expect(() => validateOverride('EMPLOYEE', { earlyEntryWindowMin: 30 })).toThrow(expect.objectContaining({ code: 'POLICY_SCOPE_NOT_ALLOWED' }));
    expect(() => validateOverride('EMPLOYEE', { operationalCutoff: '06:00' })).toThrow(expect.objectContaining({ code: 'POLICY_SCOPE_NOT_ALLOWED' }));
    expect(() => validateOverride('BRANCH', { weekStartDay: 2 })).toThrow(expect.objectContaining({ code: 'POLICY_SCOPE_NOT_ALLOWED' }));
    expect(validateOverride('ORGANIZATION', { weekStartDay: 7 })).toEqual({ weekStartDay: 7 });
    expect(() => validateOverride('BRANCH', { absentAfterMin: 0 })).toThrow(expect.objectContaining({ code: 'POLICY_VALUE_INVALID' }));
    expect(() => validateOverride('BRANCH', { operationalCutoff: '25:00' })).toThrow(expect.objectContaining({ code: 'POLICY_VALUE_INVALID' }));
    expect(() => validateOverride('BRANCH', { nonexistent: 1 } as never)).toThrow(expect.objectContaining({ code: 'POLICY_PARAM_UNKNOWN' }));
  });
});

const pools = openPools();
const world = buildWorld(pools);
let orgId: string;
let ids: Record<string, string>;
let adminCtx: ReturnType<typeof userCtx>;
let empX: string;
let empY: string;
let otherOrg: string;

beforeAll(async () => {
  const p = await world.platformAdmin.createOrganization({
    name: 'Fatboy', slug: uniq('fatboy'), timezone: 'America/Tijuana',
    branches: [{ code: 'VEN', name: 'Venecia' }, { code: 'SMA', name: 'San Marcos' }, { code: 'AME', name: 'Américas' }],
    admin: { email: `${uniq('dueno')}@ejemplo.com`, displayName: 'Dueño', password: PASSWORD },
  });
  orgId = p.organizationId;
  ids = p.branchIds;
  adminCtx = userCtx(orgId, p.adminUserId);
  empX = (await world.employees.create(adminCtx, { employeeNumber: 'X', firstName: 'X', primaryBranchId: ids.VEN! })).employee.id;
  empY = (await world.employees.create(adminCtx, { employeeNumber: 'Y', firstName: 'Y', primaryBranchId: ids.VEN! })).employee.id;
  otherOrg = (await world.platformAdmin.createOrganization({
    name: 'Pizzería X', slug: uniq('pizza'), timezone: 'America/Mexico_City', branches: [{ code: 'C', name: 'Centro' }],
    admin: { email: `${uniq('p')}@ejemplo.com`, displayName: 'P', password: PASSWORD },
  })).organizationId;
});
afterAll(() => pools.close());

describe('política efectiva (base de datos)', () => {
  it('sin overrides rige la política de plataforma', async () => {
    const { policy, sources } = await world.policies.getEffective(adminCtx, { branchId: ids.VEN, employeeId: empX });
    expect(policy).toMatchObject({ breakAllowedMin: 35, maxBreaks: 1, entryToleranceMin: 10, earlyEntryWindowMin: 60, absentAfterMin: 60, operationalCutoff: '05:00:00' });
    expect(Object.values(sources).every((s) => s === 'PLATFORM')).toBe(true);
  });

  it('Fatboy 35 → San Marcos hereda 35 → Venecia 40 → empleado X en Venecia 30', async () => {
    await world.policies.setOverride(adminCtx, 'ORGANIZATION', null, { breakAllowedMin: 35 });
    await world.policies.setOverride(adminCtx, 'BRANCH', ids.VEN!, { breakAllowedMin: 40 }, 'Venecia tiene más afluencia');
    await world.policies.setOverride(adminCtx, 'EMPLOYEE', empX, { breakAllowedMin: 30 }, 'Excepción médica');

    const eff = async (branchId: string, employeeId?: string) => (await world.policies.getEffective(adminCtx, { branchId, employeeId })).policy.breakAllowedMin;
    expect(await eff(ids.SMA!)).toBe(35);
    expect(await eff(ids.AME!)).toBe(35);
    expect(await eff(ids.VEN!)).toBe(40);
    expect(await eff(ids.VEN!, empY)).toBe(40);
    expect(await eff(ids.VEN!, empX)).toBe(30);
    expect(await eff(ids.SMA!, empX)).toBe(30); // el override de empleado lo acompaña a cualquier sucursal
  });

  it('solo se guardan overrides: la fila de un empleado tiene ÚNICAMENTE el parámetro sobrescrito (no se duplica la configuración)', async () => {
    const { rows } = await pools.platform.query(`SELECT * FROM core.policy_overrides WHERE organization_id = $1 AND employee_id = $2`, [orgId, empX]);
    expect(rows).toHaveLength(1);
    const params = Object.entries(rows[0]).filter(([k, v]) => !['id', 'organization_id', 'scope', 'branch_id', 'employee_id', 'updated_by', 'created_at', 'updated_at'].includes(k) && v !== null);
    expect(params).toEqual([['break_allowed_min', 30]]);
  });

  it('un override puede quitarse (null) y el nivel vuelve a heredar', async () => {
    await world.policies.setOverride(adminCtx, 'EMPLOYEE', empX, { breakAllowedMin: null });
    expect((await world.policies.getEffective(adminCtx, { branchId: ids.VEN, employeeId: empX })).policy.breakAllowedMin).toBe(40);
  });

  it('aplica a tolerancia, entrada anticipada y corte operativo; pausas múltiples sin tocar el modelo', async () => {
    await world.policies.setOverride(adminCtx, 'ORGANIZATION', null, { entryToleranceMin: 5, earlyEntryWindowMin: 90 });
    await world.policies.setOverride(adminCtx, 'BRANCH', ids.AME!, { operationalCutoff: '06:30', absentAfterMin: 45, maxBreaks: 2 });
    const r = await world.policies.getEffective(adminCtx, { branchId: ids.AME });
    expect(r.policy).toMatchObject({ entryToleranceMin: 5, earlyEntryWindowMin: 90, operationalCutoff: '06:30:00', absentAfterMin: 45, maxBreaks: 2 });
    expect(r.sources).toMatchObject({ operationalCutoff: 'BRANCH', entryToleranceMin: 'ORGANIZATION', requireBreak: 'PLATFORM' });
    expect((await world.policies.getEffective(adminCtx, { branchId: ids.SMA })).policy).toMatchObject({ operationalCutoff: '05:00:00', maxBreaks: 1 });
  });

  it('las políticas de un negocio no se ven ni se heredan en otro', async () => {
    const otherCtx = userCtx(otherOrg);
    expect((await world.policies.getEffective(otherCtx)).policy.entryToleranceMin).toBe(10);
    expect((await pools.platform.query(`SELECT count(*)::int AS n FROM core.policy_overrides WHERE organization_id = $1`, [otherOrg])).rows[0].n).toBe(0);
  });

  it('los cambios quedan auditados con antes/después y la sucursal', async () => {
    const { rows } = await pools.platform.query(
      `SELECT * FROM audit.audit_log WHERE organization_id = $1 AND action = 'policy.override_set' AND entity_id = $2 ORDER BY id`, [orgId, `BRANCH:${ids.VEN}`]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ branch_id: ids.VEN, reason: 'Venecia tiene más afluencia' });
    expect(rows[0].before).toBeNull();
    expect(rows[0].after.breakAllowedMin).toBe(40);
  });

  it('PostgreSQL también impone las reglas de la jerarquía (no depende del ORM)', async () => {
    const c = await pools.platform.connect();
    try {
      await c.query('BEGIN');
      const insert = (cols: string, vals: string) => pgError(c, `INSERT INTO core.policy_overrides (organization_id, ${cols}) VALUES ('${orgId}', ${vals})`);
      expect((await insert('scope, employee_id, week_start_day', `'EMPLOYEE', '${empY}', 2`))?.code, 'week_start_day por empleado').toBe('23514');
      expect((await insert('scope, employee_id, operational_cutoff', `'EMPLOYEE', '${empY}', '06:00'`))?.code, 'corte por empleado').toBe('23514');
      expect((await insert('scope, branch_id, week_start_day', `'BRANCH', '${ids.SMA}', 2`))?.code, 'week_start_day por sucursal').toBe('23514');
      expect((await insert('scope, branch_id', `'BRANCH', NULL`))?.code, 'nivel sin destino').toBe('23514');
      expect((await insert('scope, branch_id, employee_id', `'EMPLOYEE', '${ids.SMA}', '${empY}'`))?.code, 'destino ambiguo').toBe('23514');
      expect((await insert('scope, employee_id, break_allowed_min', `'EMPLOYEE', '${empY}', 9999`))?.code, 'fuera de rango').toBe('23514');
      expect((await insert('scope, branch_id, break_allowed_min', `'BRANCH', '${ids.VEN}', 20`))?.code, 'duplicado por nivel').toBe('23505');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('platform.policy_defaults es un singleton completo', async () => {
    expect((await pools.superuser.query('SELECT count(*)::int AS n FROM platform.policy_defaults')).rows[0].n).toBe(1);
    const c = await pools.platform.connect();
    try {
      await c.query('BEGIN');
      expect((await pgError(c, 'INSERT INTO platform.policy_defaults (id) VALUES (false)'))?.code).toBe('23514');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});

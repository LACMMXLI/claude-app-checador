import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, employees } from '../src/db/schema/index.js';
import { buildWorld, openPools, seedOrganization, userCtx, type SeededOrg } from './helpers/world.js';

const pools = openPools();
const world = buildWorld(pools);
let A: SeededOrg;
let B: SeededOrg;

beforeAll(async () => {
  A = await seedOrganization(world);
  B = await seedOrganization(world);
});
afterAll(() => pools.close());

describe('contexto seguro de organización (TenantDb)', () => {
  it('rechaza identificadores que no son UUID (nada se interpola en SQL)', async () => {
    await expect(world.tenantDb.run({ organizationId: `'; DROP TABLE core.employees; --`, actor: { type: 'SYSTEM' } }, async () => 1)).rejects.toThrow(/inválido/);
    await expect(world.tenantDb.run({ organizationId: A.organizationId, actor: { type: 'USER', userId: 'no-uuid' } }, async () => 1)).rejects.toThrow(/inválido/);
  });

  it('dentro de una operación solo se ven datos del negocio del contexto', async () => {
    const seen = await world.tenantDb.run(userCtx(A.organizationId, A.adminUserId), (tx) => tx.select().from(employees));
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((e) => e.organizationId))).toEqual(new Set([A.organizationId]));
  });

  it('un servicio con el contexto de A no puede leer ni modificar un empleado de B (aunque conozca su id)', async () => {
    await expect(world.employees.update(A.adminCtx, B.employeeId, { firstName: 'Hack' })).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' });
    await expect(world.employees.resetPin(A.adminCtx, B.employeeId)).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' });
    await expect(world.employees.deactivate(A.adminCtx, B.employeeId, 'x')).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' });
    const [b] = (await pools.platform.query(`SELECT first_name, status FROM core.employees WHERE id = $1`, [B.employeeId])).rows;
    expect(b).toMatchObject({ first_name: 'Juan', status: 'ACTIVE' });
  });

  it('un contexto no puede escribir auditoría a nombre de otro negocio', async () => {
    await expect(
      world.tenantDb.run(A.adminCtx, (tx) => tx.insert(auditLog).values({ organizationId: B.organizationId, actorType: 'USER', action: 'x.y', entityType: 'x' })),
    ).rejects.toThrow();
  });

  it('una sucursal, asignación o política de A no puede apuntar a datos de B a través de los servicios', async () => {
    await expect(world.employees.assignBranch(A.adminCtx, A.employeeId, { branchId: B.branchA, kind: 'PRIMARY', validFrom: '2031-01-01' })).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
    await expect(world.policies.setOverride(A.adminCtx, 'BRANCH', B.branchA, { breakAllowedMin: 1 })).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
    await expect(world.policies.setOverride(A.adminCtx, 'EMPLOYEE', B.employeeId, { breakAllowedMin: 1 })).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' });
    await expect(world.kiosks.createPairingCode(A.adminCtx, B.branchA)).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
  });

  it('el rol de la API no puede saltarse el contexto: sin set_config no hay datos', async () => {
    const { rows } = await pools.app.query('SELECT count(*)::int AS n FROM core.employees');
    expect(rows[0].n).toBe(0);
  });
});

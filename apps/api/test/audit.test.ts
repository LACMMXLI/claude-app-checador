import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redact } from '../src/modules/audit/audit.service.js';
import { buildWorld, openPools, seedOrganization, type SeededOrg } from './helpers/world.js';

const pools = openPools();
const world = buildWorld(pools);
let A: SeededOrg;

beforeAll(async () => {
  A = await seedOrganization(world);
});
afterAll(() => pools.close());

const auditRows = async (orgId: string, action?: string) =>
  (await pools.platform.query(`SELECT * FROM audit.audit_log WHERE organization_id = $1 ${action ? 'AND action = $2' : ''} ORDER BY id`, action ? [orgId, action] : [orgId])).rows;

describe('auditoría', () => {
  it('cada registro identifica el negocio y, cuando aplica, la sucursal, el actor, antes y después', async () => {
    await world.branches.update(A.adminCtx, A.branchA, { name: 'Renombrada' }, 'Cambio de nombre');
    const [row] = (await auditRows(A.organizationId, 'branch.updated')).slice(-1);
    expect(row).toMatchObject({ organization_id: A.organizationId, branch_id: A.branchA, actor_type: 'USER', actor_user_id: A.adminUserId, entity_type: 'branch', reason: 'Cambio de nombre' });
    expect(row.before.name).toBe('Sucursal A');
    expect(row.after.name).toBe('Renombrada');
    expect(row.occurred_at).toBeInstanceOf(Date);
  });

  it('las acciones de plataforma y de kiosco también quedan en la auditoría del negocio', async () => {
    const actions = (await auditRows(A.organizationId)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['organization.created', 'employee.created', 'employee.pin_generated', 'employee.assignment_created', 'kiosk.pairing_code_created', 'kiosk.paired', 'role.assigned', 'policy.override_set']));
    const paired = (await auditRows(A.organizationId, 'kiosk.paired'))[0];
    expect(paired).toMatchObject({ actor_type: 'KIOSK', actor_device_id: A.deviceId, branch_id: A.branchA });
    const platform = (await pools.platform.query(`SELECT * FROM platform.platform_audit_log WHERE organization_id = $1`, [A.organizationId])).rows;
    expect(platform.map((r) => r.action)).toContain('organization.created');
  });

  it('el cambio y su auditoría son atómicos: si la operación falla, no queda auditoría huérfana', async () => {
    const before = (await auditRows(A.organizationId)).length;
    await expect(world.employees.create(A.adminCtx, { employeeNumber: '001', firstName: 'Duplicado', primaryBranchId: A.branchA })).rejects.toMatchObject({ code: 'EMPLOYEE_NUMBER_TAKEN' });
    expect((await auditRows(A.organizationId)).length).toBe(before);
  });

  it('JAMÁS contiene el PIN, su hash, contraseñas ni tokens (alta, restablecimiento, kiosco, usuarios)', async () => {
    const { pin } = await world.employees.resetPin(A.adminCtx, A.employeeId, 'Lo olvidó');
    const { rows: [emp] } = await pools.platform.query(`SELECT pin_hash FROM core.employees WHERE id = $1`, [A.employeeId]);
    const dump = JSON.stringify(await auditRows(A.organizationId));
    expect(dump).not.toContain(pin);
    expect(dump).not.toContain(A.employeePin);
    expect(dump).not.toContain(emp.pin_hash);
    expect(dump).not.toContain(A.kioskToken);
    expect(dump).not.toContain(A.kioskToken.split('.')[1]);
    expect(dump).not.toMatch(/\$argon2/);
    const platformDump = JSON.stringify((await pools.platform.query(`SELECT * FROM platform.platform_audit_log`)).rows);
    expect(platformDump).not.toMatch(/\$argon2|una-contraseña-segura/);
    // y el restablecimiento SÍ quedó registrado (quién, a quién, cuándo)
    const reset = (await auditRows(A.organizationId, 'employee.pin_reset')).slice(-1)[0];
    expect(reset).toMatchObject({ entity_id: A.employeeId, actor_user_id: A.adminUserId, reason: 'Lo olvidó' });
    expect(reset.before).toBeNull();
    expect(reset.after).toBeNull();
  });

  it('redact() oculta recursivamente claves sensibles y conserva el resto (incluida "code" de sucursal)', () => {
    expect(
      redact({ code: 'VEN', pin: '123456', pinHash: 'abc', nested: { password: 'x', token_hash: 'y', list: [{ secret: 1, ok: 2 }] }, at: new Date('2030-01-01T00:00:00Z') }),
    ).toEqual({
      code: 'VEN',
      pin: '[REDACTED]',
      pinHash: '[REDACTED]',
      nested: { password: '[REDACTED]', token_hash: '[REDACTED]', list: [{ secret: '[REDACTED]', ok: 2 }] },
      at: '2030-01-01T00:00:00.000Z',
    });
  });

  it('la auditoría es inmutable también para el servicio: no hay forma de editarla con el rol de la API', async () => {
    await expect(world.tenantDb.run(A.adminCtx, (tx) => tx.execute(`UPDATE audit.audit_log SET reason = 'x'` as never))).rejects.toThrow();
  });
});

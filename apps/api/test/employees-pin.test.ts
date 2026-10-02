import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePin, hashPin, isTrivialPin, isWellFormedPin } from '../src/modules/core/pin.js';
import { pgError } from './helpers/sql.js';
import { PEPPER } from './helpers/config.js';
import { buildWorld, openPools, seedOrganization, type SeededOrg } from './helpers/world.js';

describe('PIN — generación y hash (puro)', () => {
  it('genera 6 dígitos con ceros a la izquierda, sin PIN triviales', () => {
    for (let i = 0; i < 2000; i += 1) {
      const pin = generatePin();
      expect(pin).toMatch(/^\d{6}$/);
      expect(isTrivialPin(pin)).toBe(false);
    }
    expect(generatePin(((values: number[]) => () => values.shift()!)([42]))).toBe('000042');
  });

  it('descarta 000000, repetidos y secuencias, y pide otro valor', () => {
    const seq = [0, 111111, 123456, 654321, 482915];
    expect(generatePin(() => seq.shift()!)).toBe('482915');
    expect(['000000', '777777', '123456', '234567', '987654'].every(isTrivialPin)).toBe(true);
    expect(isTrivialPin('482915')).toBe(false);
    expect(() => generatePin(() => 0)).toThrow();
  });

  it('hashPin: HMAC determinista, 64 hex, distinto por negocio y por pepper, y no contiene el PIN', () => {
    const h = hashPin('482915', 'org-1', PEPPER);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashPin('482915', 'org-1', PEPPER));
    expect(h).not.toBe(hashPin('482915', 'org-2', PEPPER));
    expect(h).not.toBe(hashPin('482915', 'org-1', `${PEPPER}x`));
    expect(h).not.toContain('482915');
    expect(isWellFormedPin('482915')).toBe(true);
    expect(['12345', '1234567', '12345a', ''].some(isWellFormedPin)).toBe(false);
  });
});

const pools = openPools();
const world = buildWorld(pools);
let A: SeededOrg;
let B: SeededOrg;

beforeAll(async () => {
  A = await seedOrganization(world);
  B = await seedOrganization(world);
});
afterAll(() => pools.close());

const pinRow = async (employeeId: string) => (await pools.platform.query(`SELECT pin_hash, pin_set_at, status FROM core.employees WHERE id = $1`, [employeeId])).rows[0];

describe('PIN de empleados', () => {
  it('se genera de 6 dígitos y SOLO se guarda su hash (nunca el PIN)', async () => {
    const { employee, pin } = await world.employees.create(A.adminCtx, { employeeNumber: 'P-100', firstName: 'María', primaryBranchId: A.branchA });
    expect(pin).toMatch(/^\d{6}$/);
    const row = await pinRow(employee.id);
    expect(row.pin_hash).toBe(hashPin(pin, A.organizationId, PEPPER));
    expect(row.pin_hash).not.toBe(pin);
    const whole = (await pools.platform.query(`SELECT to_jsonb(e)::text AS t FROM core.employees e WHERE id = $1`, [employee.id])).rows[0].t;
    expect(whole).not.toContain(`"${pin}"`);
    expect(JSON.stringify(employee)).not.toMatch(/pin_?hash/i); // la vista del servicio nunca incluye el hash
  });

  it('el PIN solo se muestra al generar/restablecer: no existe ninguna consulta que lo devuelva', async () => {
    const { employee } = await world.employees.create(A.adminCtx, { employeeNumber: 'P-101', firstName: 'Luis', primaryBranchId: A.branchA });
    const update = await world.employees.update(A.adminCtx, employee.id, { lastName: 'Gómez' });
    expect(Object.keys(update)).not.toContain('pin');
    expect(Object.keys(update)).not.toContain('pinHash');
  });

  it('es único entre activos del MISMO negocio: ante una colisión se genera otro PIN', async () => {
    const seq = ['482915', '482915', '739104'];
    const w = buildWorld(pools, { pinGenerator: () => seq.shift()! });
    const one = await w.employees.create(A.adminCtx, { employeeNumber: 'U-1', firstName: 'Uno', primaryBranchId: A.branchA });
    const two = await w.employees.create(A.adminCtx, { employeeNumber: 'U-2', firstName: 'Dos', primaryBranchId: A.branchA });
    expect(one.pin).toBe('482915');
    expect(two.pin).toBe('739104'); // el 482915 ya lo tenía un empleado activo de este negocio
  });

  it('el índice único también lo impone PostgreSQL (aunque el código fallara)', async () => {
    const [e1, e2] = (await pools.platform.query(`SELECT id FROM core.employees WHERE organization_id = $1 AND status = 'ACTIVE' LIMIT 2`, [A.organizationId])).rows;
    const dup = (await pools.platform.query(`SELECT pin_hash FROM core.employees WHERE id = $1`, [e1.id])).rows[0].pin_hash;
    const c = await pools.platform.connect();
    try {
      await c.query('BEGIN');
      const err = await pgError(c, `UPDATE core.employees SET pin_hash = $1 WHERE id = $2`, [dup, e2.id]);
      expect(err?.code).toBe('23505');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('el MISMO PIN puede existir en dos negocios distintos (y cada kiosco identifica solo a los suyos)', async () => {
    const w = buildWorld(pools, { pinGenerator: () => '582913' });
    const a = await w.employees.create(A.adminCtx, { employeeNumber: 'S-1', firstName: 'En A', primaryBranchId: A.branchA });
    const b = await w.employees.create(B.adminCtx, { employeeNumber: 'S-1', firstName: 'En B', primaryBranchId: B.branchA });
    expect([a.pin, b.pin]).toEqual(['582913', '582913']);
    const hashes = (await pools.platform.query(`SELECT organization_id, pin_hash FROM core.employees WHERE id = ANY($1)`, [[a.employee.id, b.employee.id]])).rows;
    expect(new Set(hashes.map((h) => h.pin_hash)).size).toBe(2); // el hash incluye el negocio
    const kioskA = world.kiosks.contextFor({ deviceId: A.deviceId, organizationId: A.organizationId, branchId: A.branchA });
    const idA = await world.kioskIdentification.identify(kioskA, A.branchA, '582913');
    expect(idA.id).toBe(a.employee.id);
  });

  it('restablecer invalida INMEDIATAMENTE el anterior; solo el nuevo identifica', async () => {
    const { employee, pin: oldPin } = await world.employees.create(A.adminCtx, { employeeNumber: 'R-1', firstName: 'Reset', primaryBranchId: A.branchA });
    const kioskCtx = world.kiosks.contextFor({ deviceId: A.deviceId, organizationId: A.organizationId, branchId: A.branchA });
    expect((await world.kioskIdentification.identify(kioskCtx, A.branchA, oldPin)).id).toBe(employee.id);
    const { pin: newPin } = await world.employees.resetPin(A.adminCtx, employee.id, 'Se lo vieron');
    expect(newPin).not.toBe(oldPin);
    await expect(world.kioskIdentification.identify(kioskCtx, A.branchA, oldPin)).rejects.toMatchObject({ code: 'INVALID_PIN' });
    expect((await world.kioskIdentification.identify(kioskCtx, A.branchA, newPin)).id).toBe(employee.id);
  });

  it('un empleado dado de baja no puede identificarse y su PIN queda invalidado (también por CHECK en BD)', async () => {
    const { employee, pin } = await world.employees.create(A.adminCtx, { employeeNumber: 'B-1', firstName: 'Baja', primaryBranchId: A.branchA });
    await expect(world.employees.deactivate(A.adminCtx, employee.id, '  ')).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    const inactive = await world.employees.deactivate(A.adminCtx, employee.id, 'Renuncia');
    expect(inactive).toMatchObject({ status: 'INACTIVE', terminationReason: 'Renuncia' });
    expect((await pinRow(employee.id)).pin_hash).toBeNull();
    const kioskCtx = world.kiosks.contextFor({ deviceId: A.deviceId, organizationId: A.organizationId, branchId: A.branchA });
    await expect(world.kioskIdentification.identify(kioskCtx, A.branchA, pin)).rejects.toMatchObject({ code: 'INVALID_PIN' });
    await expect(world.employees.resetPin(A.adminCtx, employee.id)).rejects.toMatchObject({ code: 'EMPLOYEE_INACTIVE' });
    const c = await pools.platform.connect();
    try {
      await c.query('BEGIN');
      expect((await pgError(c, `UPDATE core.employees SET pin_hash = repeat('a', 64) WHERE id = $1`, [employee.id]))?.code).toBe('23514');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('no se borra nunca: el historial se conserva y la API ni siquiera puede ejecutar DELETE', async () => {
    const { employee } = await world.employees.create(A.adminCtx, { employeeNumber: 'H-1', firstName: 'Historial', primaryBranchId: A.branchA });
    await world.employees.deactivate(A.adminCtx, employee.id, 'Fin de contrato');
    const assignments = (await pools.platform.query(`SELECT count(*)::int AS n FROM core.employee_branch_assignments WHERE employee_id = $1`, [employee.id])).rows[0].n;
    expect(assignments).toBe(1);
    await expect(world.tenantDb.run(A.adminCtx, (tx) => tx.execute(`DELETE FROM core.employees` as never))).rejects.toThrow();
  });

  it('el reingreso reactiva el mismo registro con un PIN nuevo', async () => {
    const { employee } = await world.employees.create(A.adminCtx, { employeeNumber: 'RE-1', firstName: 'Regresa', primaryBranchId: A.branchA });
    await world.employees.deactivate(A.adminCtx, employee.id, 'Baja');
    const back = await world.employees.reactivate(A.adminCtx, employee.id, 'Reingreso');
    expect(back.employee).toMatchObject({ id: employee.id, status: 'ACTIVE', terminatedAt: null });
    expect(back.pin).toMatch(/^\d{6}$/);
    await expect(world.employees.reactivate(A.adminCtx, employee.id)).rejects.toMatchObject({ code: 'EMPLOYEE_ALREADY_ACTIVE' });
  });

  it('el número de empleado es único por negocio (puede repetirse entre negocios)', async () => {
    await expect(world.employees.create(A.adminCtx, { employeeNumber: '001', firstName: 'Dup', primaryBranchId: A.branchA })).rejects.toMatchObject({ code: 'EMPLOYEE_NUMBER_TAKEN' });
    expect((await world.employees.create(B.adminCtx, { employeeNumber: 'N-77', firstName: 'N', primaryBranchId: B.branchA })).employee.employeeNumber).toBe('N-77');
    expect((await world.employees.create(A.adminCtx, { employeeNumber: 'N-77', firstName: 'N', primaryBranchId: A.branchA })).employee.employeeNumber).toBe('N-77');
  });
});

describe('asignaciones de sucursal', () => {
  it('cambiar la sucursal principal cierra la anterior y conserva el historial; solo hay una PRIMARY vigente', async () => {
    const { employee } = await world.employees.create(A.adminCtx, { employeeNumber: 'AS-1', firstName: 'Mueve', primaryBranchId: A.branchA, hiredAt: '2029-01-01' });
    await world.employees.assignBranch(A.adminCtx, employee.id, { branchId: A.branchB, kind: 'PRIMARY', validFrom: '2029-06-01' });
    const rows = (await pools.platform.query(`SELECT branch_id, kind, valid_from::text, valid_to::text FROM core.employee_branch_assignments WHERE employee_id = $1 ORDER BY valid_from`, [employee.id])).rows;
    expect(rows).toEqual([
      { branch_id: A.branchA, kind: 'PRIMARY', valid_from: '2029-01-01', valid_to: '2029-05-31' },
      { branch_id: A.branchB, kind: 'PRIMARY', valid_from: '2029-06-01', valid_to: null },
    ]);
  });

  it('la BD impide dos PRIMARY solapadas y valida el rango de las TEMPORARY', async () => {
    const { employee } = await world.employees.create(A.adminCtx, { employeeNumber: 'AS-2', firstName: 'Solapa', primaryBranchId: A.branchA, hiredAt: '2029-01-01' });
    const c = await pools.platform.connect();
    try {
      await c.query('BEGIN');
      expect((await pgError(c, `INSERT INTO core.employee_branch_assignments (organization_id, employee_id, branch_id, kind, valid_from) VALUES ($1,$2,$3,'PRIMARY','2029-03-01')`, [A.organizationId, employee.id, A.branchB]))?.code).toBe('23P01');
      expect((await pgError(c, `INSERT INTO core.employee_branch_assignments (organization_id, employee_id, branch_id, kind, valid_from, valid_to) VALUES ($1,$2,$3,'TEMPORARY','2029-03-10','2029-03-01')`, [A.organizationId, employee.id, A.branchB]))?.code).toBe('23514');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    await expect(world.employees.assignBranch(A.adminCtx, employee.id, { branchId: A.branchB, kind: 'TEMPORARY', validFrom: '2029-03-01' })).rejects.toMatchObject({ code: 'TEMPORARY_ASSIGNMENT_REQUIRES_RANGE_AND_REASON' });
    const temp = await world.employees.assignBranch(A.adminCtx, employee.id, { branchId: A.branchB, kind: 'TEMPORARY', validFrom: '2029-03-01', validTo: '2029-03-05', reason: 'Cubre vacaciones' });
    expect(temp).toMatchObject({ kind: 'TEMPORARY', validTo: '2029-03-05' });
  });

  it('la fecha de ingreso por defecto se interpreta en la zona horaria EFECTIVA de la sucursal (no en UTC)', async () => {
    // 2030-03-10 07:30 UTC → Tijuana (UTC-8, aún sin horario de verano) = 9 mar 23:30 · Ciudad de México (UTC-6) = 10 mar 01:30
    const w = buildWorld(pools, { clock: () => new Date('2030-03-10T07:30:00Z') });
    const inTijuana = await w.employees.create(A.adminCtx, { employeeNumber: 'TZ-1', firstName: 'T', primaryBranchId: A.branchA }); // hereda America/Tijuana
    const inMexico = await w.employees.create(A.adminCtx, { employeeNumber: 'TZ-2', firstName: 'M', primaryBranchId: A.branchB }); // sobrescribe America/Mexico_City
    expect(inTijuana.employee.hiredAt).toBe('2030-03-09');
    expect(inMexico.employee.hiredAt).toBe('2030-03-10');
  });
});

describe('PIN y cuentas de panel son conceptos separados', () => {
  it('el PIN de un empleado no es una credencial de panel (no existe usuario para un empleado)', async () => {
    const { employee } = await world.employees.create(A.adminCtx, { employeeNumber: 'NP-1', firstName: 'Sin cuenta', primaryBranchId: A.branchA });
    const rows = (await pools.platform.query(`SELECT 1 FROM core.organization_memberships WHERE employee_id = $1`, [employee.id])).rowCount;
    expect(rows).toBe(0);
  });
});

import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../src/common/tenancy/tenant-context.js';
import { localToUtc } from '../../src/common/zoned-time.js';
import type { PunchAction } from '../../src/modules/attendance/attendance-common.js';
import type { AccessProfile } from '../../src/modules/auth/rbac.service.js';
import { PASSWORD, type World, uniq, userCtx } from './world.js';

export const TZ = 'America/Tijuana';
/** Instante UTC de una hora local de Tijuana. */
export const at = (date: string, time: string, fold?: 'EARLIER' | 'LATER') => localToUtc(date, time, TZ, fold);

export interface Person {
  id: string;
  pin: string;
}

export interface Kiosk {
  deviceId: string;
  branchId: string;
  ctx: TenantContext;
  token: string;
}

/**
 * Fatboy (America/Tijuana) con Venecia y San Marcos, un kiosco en cada una, un ADMIN y una ENCARGADA de
 * Venecia que además es empleada (ficha ligada a su membresía, para probar "no corregir la propia jornada").
 * Antirrebote en 0 para poder encadenar checadas en las pruebas (se prueba aparte).
 */
export async function attendanceFixture(world: World, setNow: (d: Date) => void) {
  setNow(new Date('2026-09-01T12:00:00Z'));
  const slug = uniq('fatboy-att');
  const p = await world.platformAdmin.createOrganization({
    name: 'Fatboy',
    slug,
    timezone: TZ,
    branches: [{ code: 'VEN', name: 'Venecia' }, { code: 'SMA', name: 'San Marcos' }],
    admin: { email: `${slug}@ejemplo.com`, displayName: 'Dueño', password: PASSWORD },
  });
  const ctx = userCtx(p.organizationId, p.adminUserId);
  const VEN = p.branchIds.VEN!;
  const SMA = p.branchIds.SMA!;
  await world.policies.setOverride(ctx, 'ORGANIZATION', null, { debounceSec: 0 });

  let n = 0;
  const employee = async (firstName: string, branchId: string): Promise<Person> => {
    n += 1;
    const r = await world.employees.create(ctx, { employeeNumber: `E-${n}`, firstName, primaryBranchId: branchId, hiredAt: '2026-01-01' });
    return { id: r.employee.id, pin: r.pin };
  };

  // Encargada de Venecia con ficha de empleada
  const lupe = await employee('Lupe', VEN);
  const mgr = await world.pools.platform.query(
    `WITH u AS (INSERT INTO auth.users (email, display_name) VALUES ($1, 'Lupe (encargada)') RETURNING id)
     INSERT INTO core.organization_memberships (organization_id, user_id, employee_id) SELECT $2, id, $3 FROM u RETURNING id, user_id`,
    [`lupe-${slug}@ejemplo.com`, p.organizationId, lupe.id],
  );
  await world.memberships.assignRole(ctx, mgr.rows[0].id, p.encargadoRoleId, { type: 'BRANCHES', branchIds: [VEN] });

  const kiosk = async (branchId: string, name: string): Promise<Kiosk> => {
    const created = await world.kiosks.create(ctx, { name, branchId });
    const identity = await world.kiosks.authenticate(created.token);
    return { deviceId: identity.deviceId, branchId, ctx: world.kiosks.contextFor(identity), token: created.token };
  };

  const admin: AccessProfile = await world.rbac.loadAccess(ctx, p.adminMembershipId);
  const managerCtx = userCtx(p.organizationId, mgr.rows[0].user_id);
  const manager: AccessProfile = await world.rbac.loadAccess(ctx, mgr.rows[0].id);

  /** Turno OFICIAL: lo crea y publica su semana (si aún no lo estaba). */
  const publishedShift = async (person: Person, branchId: string, date: string, start: string, end: string) => {
    const s = await world.scheduling.createShift(ctx, admin, { employeeId: person.id, branchId, date, startTime: start, endTime: end }, { reason: 'Prueba' });
    const week = await world.scheduling.getWeek(ctx, admin, branchId, date);
    if (week.schedule!.status === 'DRAFT') await world.scheduling.publish(ctx, admin, week.schedule!.id, week.schedule!.version);
    return s;
  };
  const draftShift = (person: Person, branchId: string, date: string, start: string, end: string) =>
    world.scheduling.createShift(ctx, admin, { employeeId: person.id, branchId, date, startTime: start, endTime: end }, { reason: 'Prueba' });

  /** PIN → pase → acción. Devuelve el resultado de la checada. */
  const punch = async (k: Kiosk, person: Person, action: PunchAction, clientEventId: string = randomUUID()) => {
    const { ticket } = await world.kioskAttendance.identify(k.ctx, k, person.pin);
    return world.kioskAttendance.punch(k.ctx, k, { ticket, action, clientEventId });
  };

  return {
    orgId: p.organizationId,
    adminEmail: `${slug}@ejemplo.com`,
    managerEmail: `lupe-${slug}@ejemplo.com`,
    ctx,
    VEN,
    SMA,
    admin,
    manager,
    managerCtx,
    lupe,
    employee,
    kioskVEN: await kiosk(VEN, 'Tablet Venecia'),
    kioskSMA: await kiosk(SMA, 'Tablet San Marcos'),
    publishedShift,
    draftShift,
    punch,
    encargadoRoleId: p.encargadoRoleId,
  };
}
export type AttendanceFixture = Awaited<ReturnType<typeof attendanceFixture>>;

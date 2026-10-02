import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PlatformDb } from '../../src/common/tenancy/platform-db.js';
import type { TenantContext } from '../../src/common/tenancy/tenant-context.js';
import { createContainer } from '../../src/container.js';
import { PlatformAdminService, type ProvisionedOrganization } from '../../src/modules/organizations/provisioning.service.js';
import { PEPPER, URLS } from './config.js';

export const PASSWORD = 'una-contraseña-segura-123';

/** Pools: app_user (como la API), platform_ops (CLI), migrator y superusuario (solo para preparar/inspeccionar). */
export function openPools() {
  const mk = (connectionString: string, max = 5) => new pg.Pool({ connectionString, max });
  return {
    app: mk(URLS.appUser),
    platform: mk(URLS.platformOps, 3),
    migrator: mk(URLS.migrator, 2),
    superuser: mk(URLS.superuser, 2),
    async close() {
      await Promise.all([this.app.end(), this.platform.end(), this.migrator.end(), this.superuser.end()]);
    },
  };
}
export type Pools = ReturnType<typeof openPools>;

export function buildWorld(pools: Pools, overrides: { clock?: () => Date; pinGenerator?: () => string } = {}) {
  const container = createContainer({ appPool: pools.app, pinPepper: PEPPER, ...overrides });
  const platformAdmin = new PlatformAdminService(new PlatformDb(pools.platform));
  return { ...container, platformAdmin, pools };
}
export type World = ReturnType<typeof buildWorld>;

export const uniq = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export function userCtx(organizationId: string, userId?: string, extra: Partial<TenantContext> = {}): TenantContext {
  return { organizationId, actor: { type: 'USER', userId }, ...extra };
}

export interface SeededOrg extends ProvisionedOrganization {
  slug: string;
  adminEmail: string;
  adminCtx: TenantContext;
  employeeId: string;
  employeePin: string;
  encargadoMembershipId: string;
  encargadoUserId: string;
  deviceId: string;
  kioskToken: string;
  branchA: string;
  branchB: string;
}

/**
 * Crea un negocio con TODAS las tablas de Fase 0 pobladas (para las pruebas de aislamiento):
 * 2 sucursales, empleado con PIN, asignación temporal, encargado con alcance en 2 sucursales,
 * kiosco (emparejado), intentos de PIN, overrides de política y auditoría.
 */
export async function seedOrganization(world: World, opts: { timezone?: string; slug?: string; adminEmail?: string } = {}): Promise<SeededOrg> {
  const slug = opts.slug ?? uniq('org');
  const adminEmail = opts.adminEmail ?? `${slug}@ejemplo.com`;
  const provisioned = await world.platformAdmin.createOrganization({
    name: `Negocio ${slug}`,
    slug,
    timezone: opts.timezone ?? 'America/Tijuana',
    branches: [
      { code: 'A', name: 'Sucursal A' },
      { code: 'B', name: 'Sucursal B', timezone: 'America/Mexico_City' },
    ],
    admin: { email: adminEmail, displayName: `Admin ${slug}`, password: PASSWORD },
  });
  const adminCtx = userCtx(provisioned.organizationId, provisioned.adminUserId);
  const branchA = provisioned.branchIds.A!;
  const branchB = provisioned.branchIds.B!;

  const { employee, pin } = await world.employees.create(adminCtx, {
    employeeNumber: '001',
    firstName: 'Juan',
    lastName: 'Pérez',
    primaryBranchId: branchA,
  });
  await world.employees.assignBranch(adminCtx, employee.id, {
    branchId: branchB,
    kind: 'TEMPORARY',
    validFrom: '2030-01-01',
    validTo: '2030-01-31',
    reason: 'Cobertura',
  });

  // Encargado: otra identidad global con alcance en las 2 sucursales
  const encargadoEmail = `enc-${slug}@ejemplo.com`;
  const encargado = await world.pools.platform.query(
    `WITH u AS (INSERT INTO auth.users (email, display_name) VALUES ($1, 'Encargado') RETURNING id),
          m AS (INSERT INTO core.organization_memberships (organization_id, user_id)
                SELECT $2, id FROM u RETURNING id, user_id)
     SELECT id AS membership_id, user_id FROM m`,
    [encargadoEmail, provisioned.organizationId],
  );
  const encargadoMembershipId = encargado.rows[0].membership_id as string;
  const encargadoUserId = encargado.rows[0].user_id as string;
  await world.memberships.assignRole(adminCtx, encargadoMembershipId, provisioned.encargadoRoleId, { type: 'BRANCHES', branchIds: [branchA, branchB] });

  // Kiosco emparejado + intentos de PIN (uno fallido y uno correcto)
  const pairing = await world.kiosks.createPairingCode(adminCtx, branchA);
  const kiosk = await world.kiosks.redeem(pairing.code, 'Tablet principal');
  const kioskCtx = world.kiosks.contextFor(kiosk);
  await world.kioskIdentification.identify(kioskCtx, branchA, '999999').catch(() => undefined);
  await world.kioskIdentification.identify(kioskCtx, branchA, pin);
  // Segundo código sin canjear (para poblar kiosk_pairing_codes con una fila vigente)
  await world.kiosks.createPairingCode(adminCtx, branchB);

  // Invitación pendiente (el token no se conserva: solo su hash en BD)
  await world.invitations.invite(adminCtx, { email: `invitado-${slug}@ejemplo.com`, roleId: provisioned.encargadoRoleId, scope: { type: 'BRANCHES', branchIds: [branchA] } });

  // Overrides de política en los tres niveles
  await world.policies.setOverride(adminCtx, 'ORGANIZATION', null, { breakAllowedMin: 35, weekStartDay: 1 });
  await world.policies.setOverride(adminCtx, 'BRANCH', branchB, { breakAllowedMin: 40 });
  await world.policies.setOverride(adminCtx, 'EMPLOYEE', employee.id, { breakAllowedMin: 30 });

  return {
    ...provisioned,
    slug,
    adminEmail,
    adminCtx,
    employeeId: employee.id,
    employeePin: pin,
    encargadoMembershipId,
    encargadoUserId,
    deviceId: kiosk.deviceId,
    kioskToken: kiosk.token,
    branchA,
    branchB,
  };
}

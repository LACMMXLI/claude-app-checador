import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError } from '../../common/errors.js';
import type { PlatformDb } from '../../common/tenancy/platform-db.js';
import { isValidTimezone } from '../../common/time.js';
import {
  auditLog,
  branches,
  organizationMemberships,
  organizations,
  platformAuditLog,
  roleAssignments,
  rolePermissions,
  roles,
  userCredentials,
  users,
  permissions,
} from '../../db/schema/index.js';
import { hashPassword } from '../auth/password.js';

/**
 * Permisos del rol de sistema ENCARGADO (el ADMIN recibe todo el catálogo). Siempre limitados por el
 * ALCANCE de sucursales de la asignación. Cada negocio puede ajustarlos.
 */
export const ENCARGADO_PERMISSIONS = [
  'employees.view',
  'employees.manage',
  'employees.pin.manage',
  'schedules.view',
  'schedules.manage',
  'attendance.view',
  'attendance.correction.apply',
  'incidents.resolve',
  'reports.view',
  'reports.export',
] as const;

const timezoneSchema = z.string().refine(isValidTimezone, 'zona horaria IANA inválida');

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/),
  /** OBLIGATORIA: no existe zona por defecto (D-1). */
  timezone: timezoneSchema,
  branches: z.array(z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), name: z.string().trim().min(1), timezone: timezoneSchema.optional() })).default([]),
  admin: z.object({
    email: z.string().trim().toLowerCase().email(),
    displayName: z.string().trim().min(1),
    /** Solo para identidades nuevas; si el correo ya existe se reutiliza la identidad global (sin tocar su contraseña). */
    password: z.string().min(10).optional(),
  }),
});
export type CreateOrganizationInput = z.input<typeof createOrganizationSchema>;

export interface ProvisionedOrganization {
  organizationId: string;
  branchIds: Record<string, string>;
  adminUserId: string;
  adminMembershipId: string;
  adminRoleId: string;
  encargadoRoleId: string;
  createdUser: boolean;
}

/**
 * Operaciones de PLATAFORMA (rol platform_ops, BYPASSRLS). Solo se usan desde el CLI interno:
 * alta de negocios, suspensión y restablecimiento global de contraseñas (RN-IDN-03).
 */
export class PlatformAdminService {
  constructor(private readonly platformDb: PlatformDb) {}

  async createOrganization(rawInput: CreateOrganizationInput, actor = 'platform-cli'): Promise<ProvisionedOrganization> {
    const parsed = createOrganizationSchema.safeParse(rawInput);
    if (!parsed.success) throw new DomainError('INVALID_ORGANIZATION_INPUT', { issues: parsed.error.issues.map((i) => i.path.join('.')) });
    const input = parsed.data;

    return this.platformDb.run(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({ slug: input.slug, name: input.name, timezone: input.timezone })
        .returning();
      const organizationId = org!.id;

      const branchIds: Record<string, string> = {};
      for (const b of input.branches) {
        const [row] = await tx
          .insert(branches)
          .values({ organizationId, code: b.code, name: b.name, timezone: b.timezone ?? null })
          .returning();
        branchIds[b.code] = row!.id;
      }

      // Roles de sistema del negocio
      const catalog = (await tx.select({ code: permissions.code }).from(permissions)).map((p) => p.code);
      const [adminRole] = await tx.insert(roles).values({ organizationId, name: 'ADMIN', isSystem: true }).returning();
      const [encargadoRole] = await tx.insert(roles).values({ organizationId, name: 'ENCARGADO', isSystem: true }).returning();
      await tx.insert(rolePermissions).values(catalog.map((code) => ({ organizationId, roleId: adminRole!.id, permissionCode: code })));
      await tx
        .insert(rolePermissions)
        .values(ENCARGADO_PERMISSIONS.map((code) => ({ organizationId, roleId: encargadoRole!.id, permissionCode: code })));

      // Identidad global del primer administrador (se reutiliza si el correo ya existe)
      let [user] = await tx.select().from(users).where(eq(users.email, input.admin.email));
      let createdUser = false;
      if (!user) {
        if (!input.admin.password) throw new DomainError('ADMIN_PASSWORD_REQUIRED');
        [user] = await tx.insert(users).values({ email: input.admin.email, displayName: input.admin.displayName }).returning();
        await tx.insert(userCredentials).values({ userId: user!.id, passwordHash: await hashPassword(input.admin.password) });
        createdUser = true;
      }
      const [membership] = await tx.insert(organizationMemberships).values({ organizationId, userId: user!.id }).returning();
      await tx.insert(roleAssignments).values({ organizationId, membershipId: membership!.id, roleId: adminRole!.id, scope: 'ORGANIZATION' });

      await tx.insert(auditLog).values({
        organizationId,
        actorType: 'SYSTEM',
        action: 'organization.created',
        entityType: 'organization',
        entityId: organizationId,
        after: { name: input.name, slug: input.slug, timezone: input.timezone, branches: input.branches.map((b) => b.code) },
        reason: `Alta por ${actor}`,
      });
      await tx.insert(platformAuditLog).values({
        actor,
        action: 'organization.created',
        organizationId,
        details: { slug: input.slug, adminEmail: input.admin.email, createdUser },
      });

      return {
        organizationId,
        branchIds,
        adminUserId: user!.id,
        adminMembershipId: membership!.id,
        adminRoleId: adminRole!.id,
        encargadoRoleId: encargadoRole!.id,
        createdUser,
      };
    });
  }

  async setOrganizationStatus(slug: string, status: 'ACTIVE' | 'SUSPENDED', actor = 'platform-cli'): Promise<void> {
    await this.platformDb.run(async (tx) => {
      const [org] = await tx.update(organizations).set({ status }).where(eq(organizations.slug, slug)).returning();
      if (!org) throw new DomainError('ORGANIZATION_NOT_FOUND');
      await tx.insert(auditLog).values({
        organizationId: org.id,
        actorType: 'SYSTEM',
        action: 'organization.status_changed',
        entityType: 'organization',
        entityId: org.id,
        after: { status },
        reason: `Cambio por ${actor}`,
      });
      await tx.insert(platformAuditLog).values({ actor, action: 'organization.status_changed', organizationId: org.id, details: { status } });
    });
  }

  /** Restablecimiento GLOBAL de contraseña (solo plataforma, mientras no exista recuperación por correo). */
  async resetPassword(email: string, newPassword: string, actor = 'platform-cli'): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const passwordHash = await hashPassword(newPassword);
    await this.platformDb.run(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.email, normalized));
      if (!user) throw new DomainError('USER_NOT_FOUND');
      await tx
        .update(userCredentials)
        .set({ passwordHash, passwordChangedAt: new Date(), failedAttempts: 0, lockedUntil: null })
        .where(eq(userCredentials.userId, user.id));
      await tx.insert(platformAuditLog).values({ actor, action: 'user.password_reset', details: { userId: user.id } }); // sin la contraseña
    });
  }
}

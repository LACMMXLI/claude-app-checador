import { and, eq, sql } from 'drizzle-orm';
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
  policyOverrides,
  plans,
  subscriptions,
} from '../../db/schema/index.js';
import { hashPassword } from '../auth/password.js';
import { brandingSchema } from './branding.js';
import { type PolicyLayer, validateOverride } from '../policies/policy.js';
import { refreshFutureShiftOperationalDates } from '../scheduling/operational-dates.js';

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
  'attendance.correction.request', // Fase 4 (decisión 6): solicitar correcciones de su PROPIA ficha; nunca aprobarlas
  'incidents.resolve',
  'reports.view',
  'reports.export',
] as const;

const timezoneSchema = z.string().refine(isValidTimezone, 'zona horaria IANA inválida');

/**
 * Suscripción inicial (D-84). Sin ella, el trigger de BD deja al negocio en ADVANCED/ACTIVE (D-89): así aplican el CLI y las
 * pruebas. La consola de plataforma siempre la indica.
 */
export const initialSubscriptionSchema = z
  .object({
    planCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
    status: z.enum(['TRIAL', 'ACTIVE']),
    trialEndsAt: z.coerce.date().optional(),
    currentPeriodEnd: z.coerce.date().nullable().optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.status !== 'TRIAL' || v.trialEndsAt !== undefined, { message: 'trialEndsAt', path: ['trialEndsAt'] });
export type InitialSubscription = z.input<typeof initialSubscriptionSchema>;

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
  subscription: initialSubscriptionSchema.optional(),
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
      // D-84: con suscripción indicada, el trigger de BD no crea la de por defecto; se inserta la elegida en esta misma transacción
      if (input.subscription) {
        const [plan] = await tx.select().from(plans).where(eq(plans.code, input.subscription.planCode));
        if (!plan) throw new DomainError('PLAN_NOT_FOUND');
        if (!plan.isActive) throw new DomainError('PLAN_NOT_ACTIVE');
        await tx.execute(sql`select set_config('app.subscription_provided', 'on', true)`);
      }
      const [org] = await tx
        .insert(organizations)
        .values({ slug: input.slug, name: input.name, timezone: input.timezone })
        .returning();
      const organizationId = org!.id;
      if (input.subscription) {
        await tx.insert(subscriptions).values({
          organizationId,
          planCode: input.subscription.planCode,
          status: input.subscription.status,
          trialEndsAt: input.subscription.status === 'TRIAL' ? input.subscription.trialEndsAt! : null,
          currentPeriodEnd: input.subscription.status === 'ACTIVE' ? (input.subscription.currentPeriodEnd ?? null) : null,
          notes: input.subscription.notes ?? '',
        });
      }

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
    }, { actor });
  }

  async setOrganizationStatus(slug: string, status: 'ACTIVE' | 'SUSPENDED', actor = 'platform-cli'): Promise<void> {
    await this.platformDb.run(async (tx) => {
      const [org] = await tx.select().from(organizations).where(eq(organizations.slug, slug));
      if (!org) throw new DomainError('ORGANIZATION_NOT_FOUND');
      // D-84: el estado del negocio lo dicta su suscripción (un trigger lo sincroniza); aquí solo se mueve la suscripción
      const moved = await tx
        .update(subscriptions)
        .set({ status: status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED' })
        .where(eq(subscriptions.organizationId, org.id))
        .returning();
      if (moved.length === 0) await tx.update(organizations).set({ status }).where(eq(organizations.id, org.id));
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
    }, { actor });
  }

  /**
   * Override de política a nivel NEGOCIO desde el CLI de plataforma (p. ej. al dar de alta a Fatboy:
   * `breakRequiredAfterMin=360`, `exitToleranceMin=5`). Así ningún negocio queda fijo en el código ni en migraciones
   * (RN-ORG-09). Mismas validaciones de valores y niveles que el panel; queda en ambas bitácoras.
   */
  async setOrganizationPolicy(slug: string, values: PolicyLayer, actor = 'platform-cli'): Promise<void> {
    const clean = validateOverride('ORGANIZATION', values);
    if (Object.keys(clean).length === 0) throw new DomainError('VALIDATION_ERROR', { fields: ['param'] });
    await this.platformDb.run(async (tx) => {
      const [org] = await tx.select().from(organizations).where(eq(organizations.slug, slug));
      if (!org) throw new DomainError('ORGANIZATION_NOT_FOUND');
      const where = and(eq(policyOverrides.organizationId, org.id), eq(policyOverrides.scope, 'ORGANIZATION'));
      const [existing] = await tx.select().from(policyOverrides).where(where);
      if (existing) await tx.update(policyOverrides).set(clean as Record<string, unknown>).where(where);
      else await tx.insert(policyOverrides).values({ organizationId: org.id, scope: 'ORGANIZATION', ...(clean as Record<string, unknown>) });
      await tx.insert(auditLog).values({
        organizationId: org.id,
        actorType: 'SYSTEM',
        action: 'policy.override_set',
        entityType: 'policy_override',
        entityId: `ORGANIZATION:${org.id}`,
        after: clean,
        reason: `Cambio por ${actor}`,
      });
      await tx.insert(platformAuditLog).values({ actor, action: 'policy.override_set', organizationId: org.id, details: clean });
      // D-78: la nueva hora de corte aplica a los turnos que aún no empiezan
      if ('operationalCutoff' in clean) await refreshFutureShiftOperationalDates(tx, org.id, new Date());
    });
  }

  /** Imágenes de marca del negocio (logo y arte del menú). `null` quita una imagen. Nada de esto vive en el código ni en migraciones (RN-ORG-09). */
  async setOrganizationBranding(slug: string, values: { logoUrl?: string | null; artUrl?: string | null }, actor = 'platform-cli'): Promise<void> {
    const patch: Record<string, string | null> = {};
    for (const key of ['logoUrl', 'artUrl'] as const) {
      const v = values[key];
      if (v === undefined) continue;
      if (v !== null && !brandingSchema.shape[key].safeParse(v).success) throw new DomainError('VALIDATION_ERROR', { fields: [key] });
      patch[key] = v;
    }
    if (Object.keys(patch).length === 0) throw new DomainError('VALIDATION_ERROR', { fields: ['logoUrl', 'artUrl'] });
    await this.platformDb.run(async (tx) => {
      const [org] = await tx.select().from(organizations).where(eq(organizations.slug, slug));
      if (!org) throw new DomainError('ORGANIZATION_NOT_FOUND');
      const next: Record<string, unknown> = { ...(org.branding as Record<string, unknown>) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      await tx.update(organizations).set({ branding: next }).where(eq(organizations.id, org.id));
      await tx.insert(auditLog).values({ organizationId: org.id, actorType: 'SYSTEM', action: 'organization.branding_set', entityType: 'organization', entityId: org.id, before: org.branding, after: next, reason: `Cambio por ${actor}` });
      await tx.insert(platformAuditLog).values({ actor, action: 'organization.branding_set', organizationId: org.id, details: patch });
    }, { actor });
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

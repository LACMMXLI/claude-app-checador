import { sql } from 'drizzle-orm';
import { DomainError } from '../../common/errors.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';

export const PLAN_FEATURES = ['reportsExport', 'scheduleTemplates'] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export interface Entitlements {
  planCode: string;
  planName: string;
  status: 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'CANCELLED';
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  /** `null` = sin límite */
  limits: { branches: number | null; employees: number | null; kiosks: number | null; members: number | null };
  features: Record<PlanFeature, boolean>;
}

export interface SubscriptionView extends Entitlements {
  /** Uso actual: solo registros ACTIVOS (D-86). `members` incluye las invitaciones pendientes. */
  usage: { branches: number; employees: number; kiosks: number; members: number; pendingInvitations: number };
}

type EntitlementsRow = {
  plan_code: string;
  plan_name: string;
  subscription_status: Entitlements['status'];
  trial_ends_at: Date | null;
  current_period_end: Date | null;
  max_branches: number | null;
  max_employees: number | null;
  max_kiosks: number | null;
  max_members: number | null;
  features: Record<string, unknown>;
};

/**
 * Plan del negocio (D-86/D-87). Lee SOLO su propia suscripción a través de la función-puerta `core.current_entitlements()`
 * (el rol del negocio no tiene acceso a las tablas de plataforma). Los límites de cupo los exige además PostgreSQL con
 * triggers; aquí se verifican las funciones del plan y las invitaciones (el alta pública al aceptar no tiene sesión).
 */
export class EntitlementsService {
  constructor(private readonly tenantDb: TenantDb) {}

  async currentTx(tx: Tx): Promise<Entitlements> {
    const { rows } = await tx.execute<EntitlementsRow>(sql`select * from core.current_entitlements()`);
    const r = rows[0];
    if (!r) throw new DomainError('SUBSCRIPTION_NOT_FOUND');
    return {
      planCode: r.plan_code,
      planName: r.plan_name,
      status: r.subscription_status,
      trialEndsAt: r.trial_ends_at,
      currentPeriodEnd: r.current_period_end,
      limits: { branches: r.max_branches, employees: r.max_employees, kiosks: r.max_kiosks, members: r.max_members },
      features: Object.fromEntries(PLAN_FEATURES.map((f) => [f, r.features?.[f] === true])) as Record<PlanFeature, boolean>,
    };
  }

  current(ctx: TenantContext): Promise<Entitlements> {
    return this.tenantDb.runReadOnly(ctx, (tx) => this.currentTx(tx));
  }

  /** Plan + uso (la RLS limita los conteos al negocio de la sesión). */
  async view(ctx: TenantContext): Promise<SubscriptionView> {
    return this.tenantDb.runReadOnly(ctx, async (tx) => {
      const entitlements = await this.currentTx(tx);
      const { rows } = await tx.execute<{ branches: number; employees: number; kiosks: number; members: number; pending: number }>(sql`
        select (select count(*)::int from core.branches where is_active) as branches,
               (select count(*)::int from core.employees where status = 'ACTIVE') as employees,
               (select count(*)::int from core.kiosk_devices where status = 'ACTIVE') as kiosks,
               (select count(*)::int from core.organization_memberships where status = 'ACTIVE') as members,
               (select count(*)::int from core.invitations where accepted_at is null and revoked_at is null and expires_at > now()) as pending`);
      const u = rows[0]!;
      return { ...entitlements, usage: { branches: u.branches, employees: u.employees, kiosks: u.kiosks, members: u.members + u.pending, pendingInvitations: u.pending } };
    });
  }

  /** Funciones por plan (D-83): p. ej. exportar reportes o usar plantillas de horario. */
  async assertFeature(ctx: TenantContext, feature: PlanFeature): Promise<void> {
    const e = await this.current(ctx);
    if (!e.features[feature]) throw new DomainError('FEATURE_NOT_IN_PLAN', { feature, plan: e.planCode });
  }

  /** Invitar cuenta como un usuario activo más (activos + invitaciones pendientes vigentes). */
  async assertCanInvite(tx: Tx): Promise<void> {
    const e = await this.currentTx(tx);
    if (e.limits.members === null) return;
    const { rows } = await tx.execute<{ used: number }>(sql`
      select ((select count(*) from core.organization_memberships where status = 'ACTIVE')
            + (select count(*) from core.invitations where accepted_at is null and revoked_at is null and expires_at > now()))::int as used`);
    const used = rows[0]!.used;
    if (used >= e.limits.members) throw new DomainError('PLAN_LIMIT_MEMBERS', { limit: e.limits.members, used });
  }
}

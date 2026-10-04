import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, PlatformDb, type Tx, schema } from '@checador/api/platform';

const { subscriptions, subscriptionEvents, plans, platformAuditLog } = schema;

export type SubscriptionStatus = 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'CANCELLED';

export interface SubscriptionView {
  organizationId: string;
  planCode: string;
  planName: string;
  status: SubscriptionStatus;
  /** Estado que ve el cliente HOY: una prueba o vigencia ya vencida cuenta como EXPIRED aunque el barrido aún no la haya marcado. */
  effectiveStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  /** Días que faltan para el vencimiento (negativo = ya venció); `null` si no vence. */
  daysLeft: number | null;
  notes: string;
  updatedAt: Date;
}

export interface LimitWarning {
  resource: 'branches' | 'employees' | 'kiosks' | 'members';
  limit: number;
  used: number;
}

export function effectiveStatus(status: SubscriptionStatus, trialEndsAt: Date | null, currentPeriodEnd: Date | null, now: Date): SubscriptionStatus {
  if (status === 'TRIAL' && trialEndsAt && trialEndsAt <= now) return 'EXPIRED';
  if (status === 'ACTIVE' && currentPeriodEnd && currentPeriodEnd <= now) return 'EXPIRED';
  return status;
}

export function daysLeft(status: SubscriptionStatus, trialEndsAt: Date | null, currentPeriodEnd: Date | null, now: Date): number | null {
  const end = status === 'TRIAL' ? trialEndsAt : status === 'ACTIVE' ? currentPeriodEnd : null;
  return end ? Math.ceil((end.getTime() - now.getTime()) / 86_400_000) : null;
}

/** Los instantes de las consultas SQL directas llegan como texto: se normalizan a Date. */
export const asDate = (v: Date | string | null | undefined): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(v));

const future = (clock: () => Date) => z.coerce.date().refine((d) => d.getTime() > clock().getTime(), 'debe ser futura');
export const subscriptionInputs = (clock: () => Date) => ({
  changePlan: z.object({ planCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/) }),
  activate: z.object({ planCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/).optional(), currentPeriodEnd: future(clock).nullable().default(null) }),
  startTrial: z.object({ days: z.number().int().min(1).max(90), planCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/).optional() }),
  extend: z.object({ until: future(clock) }),
  reason: z.object({ reason: z.string().trim().min(3).max(300) }),
  notes: z.object({ notes: z.string().max(2000) }),
});

/**
 * Ciclo de vida de la suscripción (D-84), sin cobros: el operador fija plan, estado y vigencia a mano. Cada operación
 * bloquea la fila, valida la transición y deja huella en la bitácora de plataforma; el historial por cambio lo escribe un
 * trigger de PostgreSQL (D-85) con el operador responsable. El estado del negocio lo sincroniza otro trigger.
 */
export class SubscriptionsService {
  constructor(
    private readonly db: PlatformDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private readonly input = subscriptionInputs(() => this.clock());
  get schemas() {
    return this.input;
  }

  async get(organizationId: string): Promise<SubscriptionView> {
    return this.db.run((tx) => this.view(tx, organizationId));
  }

  async events(organizationId: string, limit = 100) {
    return this.db.run((tx) =>
      tx.select().from(subscriptionEvents).where(eq(subscriptionEvents.organizationId, organizationId)).orderBy(sql`${subscriptionEvents.id} desc`).limit(limit),
    );
  }

  private async view(tx: Tx, organizationId: string): Promise<SubscriptionView> {
    const [row] = await tx
      .select({ s: subscriptions, planName: plans.name })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.code, subscriptions.planCode))
      .where(eq(subscriptions.organizationId, organizationId));
    if (!row) throw new DomainError('CUSTOMER_NOT_FOUND');
    const now = this.clock();
    const s = row.s;
    const status = s.status as SubscriptionStatus;
    return {
      organizationId, planCode: s.planCode, planName: row.planName, status,
      effectiveStatus: effectiveStatus(status, s.trialEndsAt, s.currentPeriodEnd, now),
      trialEndsAt: s.trialEndsAt, currentPeriodEnd: s.currentPeriodEnd, daysLeft: daysLeft(status, s.trialEndsAt, s.currentPeriodEnd, now),
      notes: s.notes, updatedAt: s.updatedAt,
    };
  }

  private assertFuture(date: Date | null, field: string) {
    if (date !== null && date.getTime() <= this.clock().getTime()) throw new DomainError('VALIDATION_ERROR', { fields: [field] });
  }

  private async lock(tx: Tx, organizationId: string) {
    const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.organizationId, organizationId)).for('update');
    if (!row) throw new DomainError('CUSTOMER_NOT_FOUND');
    return row;
  }

  private async activePlan(tx: Tx, code: string) {
    const [plan] = await tx.select().from(plans).where(eq(plans.code, code));
    if (!plan) throw new DomainError('PLAN_NOT_FOUND');
    if (!plan.isActive) throw new DomainError('PLAN_NOT_ACTIVE');
    return plan;
  }

  /** Lo que el negocio ya tiene por encima de los límites de un plan (informativo: nunca se borra ni se desactiva nada). */
  private async overLimits(tx: Tx, organizationId: string, plan: typeof plans.$inferSelect): Promise<LimitWarning[]> {
    const { rows } = await tx.execute<{ branches: number; employees: number; kiosks: number; members: number }>(sql`
      select (select count(*)::int from core.branches where organization_id = ${organizationId} and is_active) as branches,
             (select count(*)::int from core.employees where organization_id = ${organizationId} and status = 'ACTIVE') as employees,
             (select count(*)::int from core.kiosk_devices where organization_id = ${organizationId} and status = 'ACTIVE') as kiosks,
             (select count(*)::int from core.organization_memberships where organization_id = ${organizationId} and status = 'ACTIVE') as members`);
    const used = rows[0]!;
    const limits = { branches: plan.maxBranches, employees: plan.maxEmployees, kiosks: plan.maxKiosks, members: plan.maxMembers };
    return (Object.keys(limits) as (keyof typeof limits)[]).flatMap((resource) => {
      const l = limits[resource];
      return l !== null && used[resource] > l ? [{ resource, limit: l, used: used[resource] }] : [];
    });
  }

  private audit(tx: Tx, actor: string, action: string, organizationId: string, details: Record<string, unknown>) {
    return tx.insert(platformAuditLog).values({ actor, action: `subscription.${action}`, organizationId, details });
  }

  async changePlan(organizationId: string, planCode: string, actor: string): Promise<{ subscription: SubscriptionView; warnings: LimitWarning[] }> {
    return this.db.run(async (tx) => {
      const current = await this.lock(tx, organizationId);
      if (current.planCode === planCode) throw new DomainError('PLAN_UNCHANGED');
      const plan = await this.activePlan(tx, planCode);
      await tx.update(subscriptions).set({ planCode }).where(eq(subscriptions.organizationId, organizationId));
      await this.audit(tx, actor, 'plan_changed', organizationId, { from: current.planCode, to: planCode });
      return { subscription: await this.view(tx, organizationId), warnings: await this.overLimits(tx, organizationId, plan) };
    }, { actor });
  }

  /** Activa (o reanuda) la suscripción; `currentPeriodEnd: null` = sin vencimiento. Sirve también para renovar la vigencia. */
  async activate(organizationId: string, input: { planCode?: string; currentPeriodEnd: Date | null }, actor: string) {
    this.assertFuture(input.currentPeriodEnd, 'currentPeriodEnd');
    return this.db.run(async (tx) => {
      const current = await this.lock(tx, organizationId);
      const plan = await this.activePlan(tx, input.planCode ?? current.planCode);
      await tx.update(subscriptions).set({ planCode: plan.code, status: 'ACTIVE', currentPeriodEnd: input.currentPeriodEnd }).where(eq(subscriptions.organizationId, organizationId));
      await this.audit(tx, actor, 'activated', organizationId, { from: current.status, plan: plan.code, currentPeriodEnd: input.currentPeriodEnd });
      return { subscription: await this.view(tx, organizationId), warnings: await this.overLimits(tx, organizationId, plan) };
    }, { actor });
  }

  async startTrial(organizationId: string, input: { days: number; planCode?: string }, actor: string) {
    return this.db.run(async (tx) => {
      const current = await this.lock(tx, organizationId);
      const plan = await this.activePlan(tx, input.planCode ?? current.planCode);
      const trialEndsAt = new Date(this.clock().getTime() + input.days * 86_400_000);
      await tx.update(subscriptions).set({ planCode: plan.code, status: 'TRIAL', trialEndsAt, currentPeriodEnd: null }).where(eq(subscriptions.organizationId, organizationId));
      await this.audit(tx, actor, 'trial_started', organizationId, { from: current.status, plan: plan.code, trialEndsAt });
      return { subscription: await this.view(tx, organizationId), warnings: await this.overLimits(tx, organizationId, plan) };
    }, { actor });
  }

  /** Extiende la prueba (TRIAL) o la vigencia (ACTIVE). Una suscripción vencida o suspendida se reactiva con `activate`. */
  async extend(organizationId: string, until: Date, actor: string): Promise<SubscriptionView> {
    this.assertFuture(until, 'until');
    return this.db.run(async (tx) => {
      const current = await this.lock(tx, organizationId);
      if (current.status === 'TRIAL') await tx.update(subscriptions).set({ trialEndsAt: until }).where(eq(subscriptions.organizationId, organizationId));
      else if (current.status === 'ACTIVE') await tx.update(subscriptions).set({ currentPeriodEnd: until }).where(eq(subscriptions.organizationId, organizationId));
      else throw new DomainError('SUBSCRIPTION_STATE_INVALID', { status: current.status });
      await this.audit(tx, actor, 'extended', organizationId, { status: current.status, until });
      return this.view(tx, organizationId);
    }, { actor });
  }

  async suspend(organizationId: string, reason: string, actor: string): Promise<SubscriptionView> {
    return this.db.run(async (tx) => {
      const current = await this.lock(tx, organizationId);
      if (!['TRIAL', 'ACTIVE', 'EXPIRED'].includes(current.status)) throw new DomainError('SUBSCRIPTION_STATE_INVALID', { status: current.status });
      await tx.update(subscriptions).set({ status: 'SUSPENDED' }).where(eq(subscriptions.organizationId, organizationId));
      await this.audit(tx, actor, 'suspended', organizationId, { from: current.status, reason });
      return this.view(tx, organizationId);
    }, { actor });
  }

  async cancel(organizationId: string, reason: string, actor: string): Promise<SubscriptionView> {
    return this.db.run(async (tx) => {
      const current = await this.lock(tx, organizationId);
      if (current.status === 'CANCELLED') throw new DomainError('SUBSCRIPTION_STATE_INVALID', { status: current.status });
      await tx.update(subscriptions).set({ status: 'CANCELLED' }).where(eq(subscriptions.organizationId, organizationId));
      await this.audit(tx, actor, 'cancelled', organizationId, { from: current.status, reason });
      return this.view(tx, organizationId);
    }, { actor });
  }

  async setNotes(organizationId: string, notes: string, actor: string): Promise<SubscriptionView> {
    return this.db.run(async (tx) => {
      await this.lock(tx, organizationId);
      await tx.update(subscriptions).set({ notes }).where(eq(subscriptions.organizationId, organizationId));
      await this.audit(tx, actor, 'notes_updated', organizationId, {}); // el texto vive solo en la suscripción
      return this.view(tx, organizationId);
    }, { actor });
  }

  /**
   * Barrido de vencimientos: pasa a EXPIRED las pruebas y vigencias que ya terminaron (el trigger suspende al negocio).
   * Idempotente. Lo ejecuta el servicio de forma periódica y las pruebas a mano.
   */
  async expireDue(): Promise<string[]> {
    const now = this.clock();
    const actor = 'system:sweeper';
    return this.db.run(async (tx) => {
      const { rows } = await tx.execute<{ organization_id: string }>(sql`
        update platform.subscriptions s set status = 'EXPIRED'
         where (s.status = 'TRIAL' and s.trial_ends_at <= ${now})
            or (s.status = 'ACTIVE' and s.current_period_end is not null and s.current_period_end <= ${now})
        returning s.organization_id`);
      for (const r of rows) await this.audit(tx, actor, 'expired', r.organization_id, {});
      return rows.map((r) => r.organization_id);
    }, { actor });
  }
}

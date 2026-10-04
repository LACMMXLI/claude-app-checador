import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, isPgError, isValidTimezone, PlatformAdminService, PlatformDb, schema } from '@checador/api/platform';
import { generatePassword } from './secrets.js';
import type { PlansService } from './plans.service.js';
import { type SubscriptionStatus, type SubscriptionView, asDate, daysLeft, effectiveStatus } from './subscriptions.service.js';

const { plans } = schema;

export interface CustomerRow {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  /** Estado del negocio en la app de clientes (lo sincroniza la suscripción). */
  organizationStatus: 'ACTIVE' | 'SUSPENDED';
  createdAt: Date;
  planCode: string;
  planName: string;
  status: SubscriptionStatus;
  effectiveStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  daysLeft: number | null;
  adminEmail: string | null;
  usage: { branches: number; employees: number; kiosks: number; members: number };
}

export interface CustomerDetail extends CustomerRow {
  notes: string;
  limits: { branches: number | null; employees: number | null; kiosks: number | null; members: number | null };
  admins: { email: string; displayName: string; status: string }[];
  branches: { id: string; code: string; name: string; isActive: boolean }[];
  lastActivityAt: Date | null;
}

export const listCustomersSchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['TRIAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED']).optional(),
  plan: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListCustomersInput = z.infer<typeof listCustomersSchema>;

const timezone = z.string().refine(isValidTimezone, 'zona horaria IANA inválida');
export const createCustomerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/),
  /** OBLIGATORIA: no existe zona por defecto (D-1). */
  timezone,
  branches: z.array(z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), name: z.string().trim().min(1).max(120), timezone: timezone.optional() })).min(1).max(100),
  admin: z.object({ email: z.string().trim().toLowerCase().email(), displayName: z.string().trim().min(1).max(120), password: z.string().min(10).max(200).optional() }),
  subscription: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('TRIAL'), planCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/), trialDays: z.number().int().min(1).max(90).default(14) }),
    z.object({ mode: z.literal('ACTIVE'), planCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/), currentPeriodEnd: z.coerce.date().nullable().default(null) }),
  ]),
  notes: z.string().max(2000).optional(),
});
export type CreateCustomerInput = z.input<typeof createCustomerSchema>;

type ListRow = {
  id: string; slug: string; name: string; timezone: string; org_status: 'ACTIVE' | 'SUSPENDED'; created_at: Date;
  plan_code: string; plan_name: string; sub_status: SubscriptionStatus; trial_ends_at: Date | null; current_period_end: Date | null;
  branches: number; employees: number; kiosks: number; members: number; admin_email: string | null; total?: number;
};

/** Clientes = negocios de la app + su suscripción (D-84). Lectura con `platform_ops`; el alta reutiliza el aprovisionamiento oficial. */
export class CustomersService {
  constructor(
    private readonly db: PlatformDb,
    private readonly admin: PlatformAdminService,
    private readonly plans: PlansService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private map(r: ListRow): CustomerRow {
    const now = this.clock();
    const trialEndsAt = asDate(r.trial_ends_at);
    const periodEnd = asDate(r.current_period_end);
    return {
      id: r.id, slug: r.slug, name: r.name, timezone: r.timezone, organizationStatus: r.org_status, createdAt: asDate(r.created_at)!,
      planCode: r.plan_code, planName: r.plan_name, status: r.sub_status,
      effectiveStatus: effectiveStatus(r.sub_status, trialEndsAt, periodEnd, now),
      trialEndsAt, currentPeriodEnd: periodEnd, daysLeft: daysLeft(r.sub_status, trialEndsAt, periodEnd, now),
      adminEmail: r.admin_email, usage: { branches: r.branches, employees: r.employees, kiosks: r.kiosks, members: r.members },
    };
  }

  private static readonly SELECT = sql`
    select o.id, o.slug, o.name, o.timezone, o.status as org_status, o.created_at,
           s.plan_code, p.name as plan_name, s.status as sub_status, s.trial_ends_at, s.current_period_end,
           (select count(*)::int from core.branches b where b.organization_id = o.id and b.is_active) as branches,
           (select count(*)::int from core.employees e where e.organization_id = o.id and e.status = 'ACTIVE') as employees,
           (select count(*)::int from core.kiosk_devices k where k.organization_id = o.id and k.status = 'ACTIVE') as kiosks,
           (select count(*)::int from core.organization_memberships m where m.organization_id = o.id and m.status = 'ACTIVE') as members,
           (select u.email from core.organization_memberships m
              join auth.users u on u.id = m.user_id
              join core.role_assignments ra on ra.membership_id = m.id
              join core.roles r on r.id = ra.role_id
             where m.organization_id = o.id and r.name = 'ADMIN' and m.status = 'ACTIVE' order by m.created_at limit 1) as admin_email
      from core.organizations o
      join platform.subscriptions s on s.organization_id = o.id
      join platform.plans p on p.code = s.plan_code`;

  async list(input: ListCustomersInput): Promise<{ total: number; items: CustomerRow[] }> {
    const where: SQL[] = [];
    if (input.status) where.push(sql`c.sub_status = ${input.status}`);
    if (input.plan) where.push(sql`c.plan_code = ${input.plan}`);
    if (input.q) {
      const like = `%${input.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push(sql`(c.name ilike ${like} or c.slug ilike ${like} or c.admin_email ilike ${like})`);
    }
    const clause = where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``;
    return this.db.run(async (tx) => {
      const { rows } = await tx.execute<ListRow>(sql`
        select c.*, count(*) over()::int as total from (${CustomersService.SELECT}) c ${clause}
        order by c.created_at desc limit ${input.limit} offset ${input.offset}`);
      return { total: rows[0]?.total ?? 0, items: rows.map((r) => this.map(r)) };
    });
  }

  async get(id: string): Promise<CustomerDetail> {
    if (!z.string().uuid().safeParse(id).success) throw new DomainError('CUSTOMER_NOT_FOUND');
    return this.db.run(async (tx) => {
      const { rows } = await tx.execute<ListRow & { notes: string }>(sql`
        select c.*, (select notes from platform.subscriptions where organization_id = c.id) as notes
          from (${CustomersService.SELECT}) c where c.id = ${id}`);
      const base = rows[0];
      if (!base) throw new DomainError('CUSTOMER_NOT_FOUND');
      const [plan] = await tx.select().from(plans).where(sql`${plans.code} = ${base.plan_code}`);
      const admins = await tx.execute<{ email: string; display_name: string; status: string }>(sql`
        select distinct u.email, u.display_name, m.status
          from core.organization_memberships m
          join auth.users u on u.id = m.user_id
          join core.role_assignments ra on ra.membership_id = m.id
          join core.roles r on r.id = ra.role_id
         where m.organization_id = ${id} and r.name = 'ADMIN' order by u.email`);
      const branches = await tx.execute<{ id: string; code: string; name: string; is_active: boolean }>(sql`
        select id, code, name, is_active from core.branches where organization_id = ${id} order by code`);
      const activity = await tx.execute<{ last: Date | null }>(sql`select max(last_seen_at) as last from auth.sessions where organization_id = ${id}`);
      return {
        ...this.map(base),
        notes: base.notes,
        limits: { branches: plan!.maxBranches, employees: plan!.maxEmployees, kiosks: plan!.maxKiosks, members: plan!.maxMembers },
        admins: admins.rows.map((a) => ({ email: a.email, displayName: a.display_name, status: a.status })),
        branches: branches.rows.map((b) => ({ id: b.id, code: b.code, name: b.name, isActive: b.is_active })),
        lastActivityAt: asDate(activity.rows[0]?.last),
      };
    });
  }

  /**
   * Alta de un cliente (D-88): negocio + sucursales + primer administrador + suscripción, en UNA transacción.
   * La contraseña inicial del administrador se genera (o la escribe el operador) y solo se devuelve si la identidad es nueva.
   */
  async create(raw: CreateCustomerInput, actor: string) {
    const parsed = createCustomerSchema.safeParse(raw);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', { fields: parsed.error.issues.map((i) => i.path.join('.')) });
    const input = parsed.data;
    const plan = await this.plans.get(input.subscription.planCode);
    if (!plan.isActive) throw new DomainError('PLAN_NOT_ACTIVE');
    if (plan.limits.branches !== null && input.branches.length > plan.limits.branches) {
      throw new DomainError('PLAN_LIMIT_BRANCHES', { limit: plan.limits.branches, requested: input.branches.length });
    }
    const generated = input.admin.password ? null : generatePassword();
    try {
      const result = await this.admin.createOrganization(
        {
          name: input.name, slug: input.slug, timezone: input.timezone, branches: input.branches,
          admin: { email: input.admin.email, displayName: input.admin.displayName, password: input.admin.password ?? generated! },
          subscription:
            input.subscription.mode === 'TRIAL'
              ? { planCode: input.subscription.planCode, status: 'TRIAL', trialEndsAt: new Date(this.clock().getTime() + input.subscription.trialDays * 86_400_000), notes: input.notes }
              : { planCode: input.subscription.planCode, status: 'ACTIVE', currentPeriodEnd: input.subscription.currentPeriodEnd, notes: input.notes },
        },
        actor,
      );
      return {
        organizationId: result.organizationId,
        slug: input.slug,
        admin: { email: input.admin.email, createdUser: result.createdUser, initialPassword: result.createdUser ? (generated ?? null) : null },
      };
    } catch (error) {
      if (isPgError(error, '23505')) throw new DomainError('ORGANIZATION_SLUG_TAKEN');
      throw error;
    }
  }
}

export type { SubscriptionView };

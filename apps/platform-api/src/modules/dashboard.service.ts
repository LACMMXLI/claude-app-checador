import { sql } from 'drizzle-orm';
import { PlatformDb } from '@checador/api/platform';
import { asDate } from './subscriptions.service.js';

export interface DashboardView {
  totals: { customers: number; employees: number; branches: number; kiosks: number };
  byStatus: Record<string, number>;
  byPlan: { planCode: string; planName: string; customers: number }[];
  /** Pruebas y vigencias que vencen en los próximos 14 días (o ya vencieron sin barrerse). */
  expiringSoon: { id: string; name: string; slug: string; planCode: string; status: string; endsAt: Date }[];
  recent: { id: string; name: string; slug: string; planCode: string; status: string; createdAt: Date }[];
}

/** Resumen para operar la plataforma: cuántos clientes hay, en qué estado, quién está por vencer y quién entró recién. */
export class DashboardService {
  constructor(
    private readonly db: PlatformDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async get(): Promise<DashboardView> {
    const now = this.clock();
    return this.db.run(async (tx) => {
      const totals = (await tx.execute<{ customers: number; employees: number; branches: number; kiosks: number }>(sql`
        select (select count(*)::int from core.organizations) as customers,
               (select count(*)::int from core.employees where status = 'ACTIVE') as employees,
               (select count(*)::int from core.branches where is_active) as branches,
               (select count(*)::int from core.kiosk_devices where status = 'ACTIVE') as kiosks`)).rows[0]!;
      const byStatus = Object.fromEntries((await tx.execute<{ status: string; n: number }>(sql`select status, count(*)::int as n from platform.subscriptions group by status`)).rows.map((r) => [r.status, r.n]));
      const byPlan = (await tx.execute<{ plan_code: string; plan_name: string; n: number }>(sql`
        select p.code as plan_code, p.name as plan_name, count(s.organization_id)::int as n
          from platform.plans p left join platform.subscriptions s on s.plan_code = p.code group by p.code, p.name, p.sort_order order by p.sort_order`)).rows;
      const expiring = (await tx.execute<{ id: string; name: string; slug: string; plan_code: string; status: string; ends_at: Date }>(sql`
        select o.id, o.name, o.slug, s.plan_code, s.status, coalesce(case s.status when 'TRIAL' then s.trial_ends_at else s.current_period_end end, ${now}::timestamptz) as ends_at
          from platform.subscriptions s join core.organizations o on o.id = s.organization_id
         where (s.status = 'TRIAL' and s.trial_ends_at <= ${now}::timestamptz + interval '14 days')
            or (s.status = 'ACTIVE' and s.current_period_end is not null and s.current_period_end <= ${now}::timestamptz + interval '14 days')
         order by ends_at limit 20`)).rows;
      const recent = (await tx.execute<{ id: string; name: string; slug: string; plan_code: string; status: string; created_at: Date }>(sql`
        select o.id, o.name, o.slug, s.plan_code, s.status, o.created_at
          from core.organizations o join platform.subscriptions s on s.organization_id = o.id order by o.created_at desc limit 8`)).rows;
      return {
        totals,
        byStatus,
        byPlan: byPlan.map((p) => ({ planCode: p.plan_code, planName: p.plan_name, customers: p.n })),
        expiringSoon: expiring.map((e) => ({ id: e.id, name: e.name, slug: e.slug, planCode: e.plan_code, status: e.status, endsAt: asDate(e.ends_at)! })),
        recent: recent.map((r) => ({ id: r.id, name: r.name, slug: r.slug, planCode: r.plan_code, status: r.status, createdAt: asDate(r.created_at)! })),
      };
    });
  }
}

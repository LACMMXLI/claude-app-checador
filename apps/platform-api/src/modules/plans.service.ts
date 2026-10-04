import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, PlatformDb, schema } from '@checador/api/platform';

const { plans, platformAuditLog } = schema;

export const FEATURES = ['reportsExport', 'scheduleTemplates'] as const;
export type Feature = (typeof FEATURES)[number];

export interface PlanView {
  code: string;
  name: string;
  description: string;
  /** `null` = sin límite */
  limits: { branches: number | null; employees: number | null; kiosks: number | null; members: number | null };
  features: Record<Feature, boolean>;
  sortOrder: number;
  isActive: boolean;
  customers: number;
}

const limit = z.number().int().min(1).max(100_000).nullable();
export const updatePlanSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(300).optional(),
  limits: z.object({ branches: limit.optional(), employees: limit.optional(), kiosks: limit.optional(), members: limit.optional() }).optional(),
  features: z.object({ reportsExport: z.boolean().optional(), scheduleTemplates: z.boolean().optional() }).optional(),
  isActive: z.boolean().optional(),
});
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

const toView = (p: typeof plans.$inferSelect, customers: number): PlanView => ({
  code: p.code,
  name: p.name,
  description: p.description,
  limits: { branches: p.maxBranches, employees: p.maxEmployees, kiosks: p.maxKiosks, members: p.maxMembers },
  features: Object.fromEntries(FEATURES.map((f) => [f, (p.features as Record<string, unknown>)[f] === true])) as Record<Feature, boolean>,
  sortOrder: p.sortOrder,
  isActive: p.isActive,
  customers,
});

/**
 * Catálogo de planes (D-83). Hay dos planes semilla (BASIC y ADVANCED) que el operador edita: nombre, límites, funciones y
 * disponibilidad. Cambiar un plan no toca datos de nadie: solo cambia lo que se puede crear/usar en adelante (D-86).
 */
export class PlansService {
  constructor(private readonly db: PlatformDb) {}

  async list(): Promise<PlanView[]> {
    return this.db.run(async (tx) => {
      const rows = await tx.select().from(plans).orderBy(asc(plans.sortOrder), asc(plans.code));
      const { rows: counts } = await tx.execute<{ plan_code: string; n: number }>(sql`select plan_code, count(*)::int as n from platform.subscriptions group by plan_code`);
      const byPlan = new Map(counts.map((c) => [c.plan_code, c.n]));
      return rows.map((p) => toView(p, byPlan.get(p.code) ?? 0));
    });
  }

  async get(code: string): Promise<PlanView> {
    return (await this.list()).find((p) => p.code === code) ?? Promise.reject(new DomainError('PLAN_NOT_FOUND'));
  }

  async update(code: string, patch: UpdatePlanInput, actor: string): Promise<PlanView> {
    await this.db.run(async (tx) => {
      const [before] = await tx.select().from(plans).where(eq(plans.code, code)).for('update');
      if (!before) throw new DomainError('PLAN_NOT_FOUND');
      if (patch.isActive === false && before.isActive) {
        const active = await tx.select({ code: plans.code }).from(plans).where(eq(plans.isActive, true));
        if (active.length <= 1) throw new DomainError('LAST_ACTIVE_PLAN');
      }
      const set: Partial<typeof plans.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.isActive !== undefined) set.isActive = patch.isActive;
      if (patch.limits) {
        if (patch.limits.branches !== undefined) set.maxBranches = patch.limits.branches;
        if (patch.limits.employees !== undefined) set.maxEmployees = patch.limits.employees;
        if (patch.limits.kiosks !== undefined) set.maxKiosks = patch.limits.kiosks;
        if (patch.limits.members !== undefined) set.maxMembers = patch.limits.members;
      }
      if (patch.features) set.features = { ...(before.features as Record<string, unknown>), ...patch.features };
      if (Object.keys(set).length === 0) throw new DomainError('VALIDATION_ERROR', { fields: ['(vacío)'] });
      const [after] = await tx.update(plans).set(set).where(eq(plans.code, code)).returning();
      await tx.insert(platformAuditLog).values({
        actor,
        action: 'plan.updated',
        details: { code, before: toView(before, 0), after: toView(after!, 0) },
      });
    }, { actor });
    return this.get(code);
  }
}

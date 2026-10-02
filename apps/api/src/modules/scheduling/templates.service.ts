import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, isPgError } from '../../common/errors.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';
import { addDaysToDate, isValidLocalTime, weekStartOf } from '../../common/zoned-time.js';
import { branches, employees, scheduleTemplateEntries, scheduleTemplates } from '../../db/schema/index.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AccessProfile } from '../auth/rbac.service.js';
import type { SchedulingService } from './scheduling.service.js';

export const templateEntrySchema = z.object({
  employeeId: z.string().uuid(),
  weekday: z.number().int().min(1).max(7), // ISO: 1 = lunes … 7 = domingo
  startTime: z.string().refine(isValidLocalTime, 'HH:MM'),
  endTime: z.string().refine(isValidLocalTime, 'HH:MM'),
});
export type TemplateEntryInput = z.infer<typeof templateEntrySchema>;

const hhmm = (t: string) => t.slice(0, 5);

/**
 * Plantillas de horario (D-23): patrón semanal por sucursal que AYUDA a generar semanas. Editar una
 * plantilla jamás modifica turnos ya generados (los turnos son copias independientes con su propio
 * `timezone_snapshot`; solo guardan `source_template_id` como referencia).
 */
export class TemplatesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly scheduling: SchedulingService,
  ) {}

  private async load(tx: Tx, templateId: string, access: AccessProfile) {
    const [t] = await tx.select().from(scheduleTemplates).where(eq(scheduleTemplates.id, templateId));
    if (!t || !access.can('schedules.view', t.branchId)) throw new DomainError('TEMPLATE_NOT_FOUND');
    const entries = await tx
      .select()
      .from(scheduleTemplateEntries)
      .where(eq(scheduleTemplateEntries.templateId, templateId))
      .orderBy(asc(scheduleTemplateEntries.weekday), asc(scheduleTemplateEntries.startLocal));
    return {
      ...t,
      entries: entries.map((e) => ({ id: e.id, employeeId: e.employeeId, weekday: e.weekday, startTime: hhmm(e.startLocal), endTime: hhmm(e.endLocal) })),
    };
  }

  list(ctx: TenantContext, access: AccessProfile, branchId?: string) {
    return this.tenantDb.run(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(scheduleTemplates)
        .where(branchId ? eq(scheduleTemplates.branchId, branchId) : undefined)
        .orderBy(asc(scheduleTemplates.name));
      return rows.filter((t) => access.can('schedules.view', t.branchId));
    });
  }

  get(ctx: TenantContext, access: AccessProfile, templateId: string) {
    return this.tenantDb.run(ctx, (tx) => this.load(tx, templateId, access));
  }

  async create(ctx: TenantContext, access: AccessProfile, input: { branchId: string; name: string }) {
    if (!access.can('schedules.templates.manage', input.branchId)) throw new DomainError('FORBIDDEN', { permission: 'schedules.templates.manage' });
    return this.tenantDb.run(ctx, async (tx) => {
      const [b] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId));
      if (!b) throw new DomainError('BRANCH_NOT_FOUND');
      try {
        const [t] = await tx
          .insert(scheduleTemplates)
          .values({ organizationId: ctx.organizationId, branchId: input.branchId, name: input.name, createdBy: ctx.actor.userId ?? null })
          .returning();
        await this.audit.record(tx, ctx, { action: 'template.created', entityType: 'schedule_template', entityId: t!.id, branchId: input.branchId, after: t });
        return { ...t!, entries: [] };
      } catch (error) {
        if (isPgError(error, '23505')) throw new DomainError('TEMPLATE_NAME_TAKEN');
        throw error;
      }
    });
  }

  /** Reemplaza el patrón completo (concurrencia optimista). No toca ningún turno existente. */
  async replaceEntries(ctx: TenantContext, access: AccessProfile, templateId: string, expectedVersion: number, entries: TemplateEntryInput[], patch: { name?: string; isActive?: boolean } = {}) {
    const clean = z.array(templateEntrySchema).parse(entries);
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.load(tx, templateId, access);
      if (!access.can('schedules.templates.manage', before.branchId)) throw new DomainError('FORBIDDEN', { permission: 'schedules.templates.manage' });
      const ids = [...new Set(clean.map((e) => e.employeeId))];
      if (ids.length) {
        const found = await tx.select({ id: employees.id }).from(employees).where(inArray(employees.id, ids));
        if (found.length !== ids.length) throw new DomainError('EMPLOYEE_NOT_FOUND');
      }
      const [updated] = await tx
        .update(scheduleTemplates)
        .set({ version: before.version + 1, ...(patch.name ? { name: patch.name } : {}), ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }) })
        .where(and(eq(scheduleTemplates.id, templateId), eq(scheduleTemplates.version, expectedVersion)))
        .returning();
      if (!updated) throw new DomainError('TEMPLATE_VERSION_CONFLICT', { currentVersion: before.version });
      await tx.delete(scheduleTemplateEntries).where(eq(scheduleTemplateEntries.templateId, templateId));
      if (clean.length) {
        try {
          await tx.insert(scheduleTemplateEntries).values(
            clean.map((e) => ({ organizationId: ctx.organizationId, templateId, employeeId: e.employeeId, weekday: e.weekday, startLocal: e.startTime, endLocal: e.endTime })),
          );
        } catch (error) {
          if (isPgError(error, '23505')) throw new DomainError('TEMPLATE_DUPLICATE_ENTRY');
          if (isPgError(error, '23514')) throw new DomainError('TEMPLATE_ENTRY_INVALID');
          throw error;
        }
      }
      const after = await this.load(tx, templateId, access);
      await this.audit.record(tx, ctx, {
        action: 'template.updated',
        entityType: 'schedule_template',
        entityId: templateId,
        branchId: before.branchId,
        before: { name: before.name, isActive: before.isActive, version: before.version, entries: before.entries },
        after: { name: after.name, isActive: after.isActive, version: after.version, entries: after.entries },
      });
      return after;
    });
  }

  /** Genera los turnos de una semana (en BORRADOR) a partir de la plantilla. */
  async apply(ctx: TenantContext, access: AccessProfile, templateId: string, input: { weekStart: string; dryRun?: boolean }) {
    const template = await this.get(ctx, access, templateId);
    if (!template.isActive) throw new DomainError('TEMPLATE_INACTIVE');
    return this.scheduling.generate(ctx, access, {
      branchId: template.branchId,
      targetWeekStart: input.weekStart,
      dryRun: input.dryRun,
      auditAction: 'template.applied',
      auditExtra: { templateId, templateVersion: template.version },
      candidates: async (_tx, weekStartDay) => {
        const start = weekStartOf(input.weekStart, weekStartDay);
        return template.entries.map((e) => ({
          employeeId: e.employeeId,
          date: addDaysToDate(start, (e.weekday - weekStartDay + 7) % 7),
          startTime: e.startTime,
          endTime: e.endTime,
          source: 'TEMPLATE' as const,
          sourceTemplateId: templateId,
        }));
      },
    });
  }
}

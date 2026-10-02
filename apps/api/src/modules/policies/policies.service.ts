import { and, eq } from 'drizzle-orm';
import { DomainError } from '../../common/errors.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';
import { employees, branches, policyDefaults, policyOverrides } from '../../db/schema/index.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  POLICY_KEYS,
  type EffectivePolicy,
  type PolicyLayer,
  type PolicyScope,
  type ResolvedPolicy,
  resolvePolicy,
  validateOverride,
} from './policy.js';

type OverrideRow = typeof policyOverrides.$inferSelect;

/** postgres `time` llega como HH:MM:SS; se normaliza a HH:MM:SS siempre. */
const normalizeTime = (t: string): string => (t.length === 5 ? `${t}:00` : t);

function layerFromRow(row: OverrideRow | undefined): PolicyLayer | undefined {
  if (!row) return undefined;
  const layer: Record<string, unknown> = {};
  for (const key of POLICY_KEYS) layer[key] = (row as Record<string, unknown>)[key] ?? null;
  return layer as PolicyLayer;
}

export class PoliciesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /** Política de plataforma (singleton completo). */
  private async platformDefaults(tx: Tx): Promise<EffectivePolicy> {
    const [row] = await tx.select().from(policyDefaults);
    if (!row) throw new Error('platform.policy_defaults vacío');
    const { id: _id, updatedAt: _u, ...rest } = row;
    return { ...rest, operationalCutoff: normalizeTime(rest.operationalCutoff) } as EffectivePolicy;
  }

  /** Política efectiva = plataforma → negocio → sucursal (donde se trabajó) → empleado. */
  async getEffective(
    ctx: TenantContext,
    target: { branchId?: string; employeeId?: string } = {},
  ): Promise<ResolvedPolicy> {
    return this.tenantDb.run(ctx, (tx) => this.getEffectiveTx(tx, ctx, target));
  }

  async getEffectiveTx(
    tx: Tx,
    ctx: TenantContext,
    target: { branchId?: string; employeeId?: string } = {},
  ): Promise<ResolvedPolicy> {
    const platform = await this.platformDefaults(tx);
    const rows = await tx.select().from(policyOverrides); // RLS: solo overrides de este negocio
    const org = rows.find((r) => r.scope === 'ORGANIZATION');
    const branch = target.branchId ? rows.find((r) => r.scope === 'BRANCH' && r.branchId === target.branchId) : undefined;
    const employee = target.employeeId ? rows.find((r) => r.scope === 'EMPLOYEE' && r.employeeId === target.employeeId) : undefined;
    const resolved = resolvePolicy(platform, {
      organization: layerFromRow(org),
      branch: layerFromRow(branch),
      employee: layerFromRow(employee),
    });
    resolved.policy.operationalCutoff = normalizeTime(resolved.policy.operationalCutoff);
    return resolved;
  }

  /**
   * Crea/actualiza el override de un nivel. Solo se guardan los parámetros indicados;
   * un valor `null` quita ese override (vuelve a heredar). Auditado con antes/después.
   */
  async setOverride(
    ctx: TenantContext,
    scope: PolicyScope,
    targetId: string | null,
    values: PolicyLayer,
    reason?: string,
  ): Promise<void> {
    const clean = validateOverride(scope, values);
    await this.tenantDb.run(ctx, async (tx) => {
      const where =
        scope === 'ORGANIZATION'
          ? eq(policyOverrides.scope, 'ORGANIZATION')
          : scope === 'BRANCH'
            ? and(eq(policyOverrides.scope, 'BRANCH'), eq(policyOverrides.branchId, targetId ?? ''))
            : and(eq(policyOverrides.scope, 'EMPLOYEE'), eq(policyOverrides.employeeId, targetId ?? ''));

      let branchForAudit: string | null = null;
      if (scope === 'BRANCH') {
        const [b] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, targetId ?? ''));
        if (!b) throw new DomainError('BRANCH_NOT_FOUND');
        branchForAudit = b.id;
      }
      if (scope === 'EMPLOYEE') {
        const [e] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.id, targetId ?? ''));
        if (!e) throw new DomainError('EMPLOYEE_NOT_FOUND');
      }

      const [existing] = await tx.select().from(policyOverrides).where(where);
      const before = layerFromRow(existing) ?? null;
      const patch = { ...clean, updatedBy: ctx.actor.userId ?? null } as Record<string, unknown>;

      if (existing) {
        await tx.update(policyOverrides).set(patch).where(eq(policyOverrides.id, existing.id));
      } else {
        await tx.insert(policyOverrides).values({
          organizationId: ctx.organizationId,
          scope,
          branchId: scope === 'BRANCH' ? targetId : null,
          employeeId: scope === 'EMPLOYEE' ? targetId : null,
          ...patch,
        });
      }
      const [after] = await tx.select().from(policyOverrides).where(where);
      await this.audit.record(tx, ctx, {
        action: 'policy.override_set',
        entityType: 'policy_override',
        entityId: `${scope}:${targetId ?? ctx.organizationId}`,
        branchId: branchForAudit,
        before,
        after: layerFromRow(after),
        reason,
      });
    });
  }
}

import { eq } from 'drizzle-orm';
import type { OperationalCalendar } from '../../common/operational-day.js';
import type { Tx } from '../../common/tenancy/tenant-db.js';
import { effectiveTimezone } from '../../common/time.js';
import { branches, organizations, policyDefaults, policyOverrides } from '../../db/schema/index.js';
import { POLICY_KEYS, type EffectivePolicy, type PolicyLayer, resolvePolicy } from './policy.js';

const normalizeTime = (t: string): string => (t.length === 5 ? `${t}:00` : t);

function layerOf(row: (typeof policyOverrides.$inferSelect) | undefined): PolicyLayer | undefined {
  if (!row) return undefined;
  return Object.fromEntries(POLICY_KEYS.map((k) => [k, (row as Record<string, unknown>)[k] ?? null])) as PolicyLayer;
}

export interface OrganizationCalendars {
  /** Calendario del negocio (zona del negocio, corte a nivel negocio): "hoy" cuando no se elige sucursal. */
  organization: OperationalCalendar;
  /** Calendario efectivo de cada sucursal: zona (sucursal → negocio) y corte (sucursal → negocio → plataforma). */
  branches: Map<string, OperationalCalendar>;
}

/**
 * D-78 · ÚNICO lugar donde se resuelve el calendario operativo (zona + hora de corte) de un negocio y sus sucursales,
 * con la misma jerarquía de políticas que todo lo demás (`resolvePolicy`). Filtra SIEMPRE por `organizationId`, así que
 * sirve igual dentro del contexto de un negocio (RLS) que desde el CLI de plataforma.
 */
export async function organizationCalendars(tx: Tx, organizationId: string): Promise<OrganizationCalendars> {
  const [org] = await tx.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, organizationId));
  if (!org) throw new Error(`Negocio ${organizationId} no visible`);
  const [defaults] = await tx.select().from(policyDefaults);
  if (!defaults) throw new Error('platform.policy_defaults vacío');
  const { id: _id, updatedAt: _u, ...platform } = defaults;
  const overrides = await tx.select().from(policyOverrides).where(eq(policyOverrides.organizationId, organizationId));
  const orgLayer = layerOf(overrides.find((r) => r.scope === 'ORGANIZATION'));
  const cutoffFor = (branchId?: string) =>
    normalizeTime(
      resolvePolicy(platform as EffectivePolicy, {
        organization: orgLayer,
        branch: branchId ? layerOf(overrides.find((r) => r.scope === 'BRANCH' && r.branchId === branchId)) : undefined,
      }).policy.operationalCutoff,
    );
  const rows = await tx.select({ id: branches.id, timezone: branches.timezone }).from(branches).where(eq(branches.organizationId, organizationId));
  return {
    organization: { timezone: org.timezone, cutoff: cutoffFor() },
    branches: new Map(rows.map((b) => [b.id, { timezone: effectiveTimezone(b.timezone, org.timezone), cutoff: cutoffFor(b.id) }])),
  };
}

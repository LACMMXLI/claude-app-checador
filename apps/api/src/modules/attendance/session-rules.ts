import { and, eq } from 'drizzle-orm';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx } from '../../common/tenancy/tenant-db.js';
import { incidents, workSessions } from '../../db/schema/index.js';
import type { EffectivePolicy } from '../policies/policy.js';
import { type IncidentType, type PolicySnapshot, breaksOf, loadShift, openIncident, resolveIncidents } from './attendance-common.js';
import { isLate, minutesBetween } from './attendance-time.js';

/** Valores de política con los que se evalúa una jornada: SIEMPRE su snapshot; la política actual solo como respaldo
 * para jornadas históricas que no congelaron algún valor (precisión D del contrato de la Fase 4). */
export type SessionPolicy = Pick<
  PolicySnapshot,
  'entryToleranceMin' | 'exitToleranceMin' | 'requireBreak' | 'breakRequiredAfterMin'
>;

export function policyFor(snapshot: Partial<PolicySnapshot>, current: EffectivePolicy | null): SessionPolicy {
  const pick = <K extends keyof SessionPolicy>(k: K): SessionPolicy[K] => (snapshot[k] ?? current?.[k]) as SessionPolicy[K];
  return {
    entryToleranceMin: pick('entryToleranceMin'),
    exitToleranceMin: pick('exitToleranceMin'),
    requireBreak: pick('requireBreak'),
    breakRequiredAfterMin: pick('breakRequiredAfterMin'),
  };
}

export const needsCurrentPolicy = (snapshot: Partial<PolicySnapshot>): boolean =>
  (['entryToleranceMin', 'exitToleranceMin', 'requireBreak', 'breakRequiredAfterMin'] as const).some((k) => snapshot[k] === undefined);

/** Lo que una jornada DEBERÍA tener abierto según sus valores efectivos (función pura, con pruebas). */
export function expectedIncidents(
  session: { startedAt: Date; endedAt: Date | null },
  shift: { startsAt: Date; endsAt: Date } | null,
  breaksList: readonly { endedAt: Date | null; exceededMinutes: number | null; id: string; sequence: number }[],
  policy: SessionPolicy,
): Map<IncidentType, Record<string, unknown>> {
  const out = new Map<IncidentType, Record<string, unknown>>();
  if (shift) {
    const delta = minutesBetween(shift.startsAt, session.startedAt);
    if (isLate(delta, policy.entryToleranceMin)) out.set('RETARDO', { lateMinutes: delta, toleranceMin: policy.entryToleranceMin });
  }
  const exceeded = breaksList.filter((b) => (b.exceededMinutes ?? 0) > 0);
  if (exceeded.length) out.set('COMIDA_EXCEDIDA', { breaks: exceeded.map((b) => ({ breakId: b.id, sequence: b.sequence, exceededMinutes: b.exceededMinutes })) });
  if (session.endedAt) {
    // D-67: salida efectiva antes de ends_at − tolerancia (minutos truncados); salir tarde no es incidencia (D-65)
    if (shift) {
      const departure = minutesBetween(shift.endsAt, session.endedAt);
      if (departure < -policy.exitToleranceMin) out.set('SALIDA_ANTICIPADA', { earlyMinutes: -departure, toleranceMin: policy.exitToleranceMin });
    }
    // D-68: comida obligatoria sin ninguna pausa cerrada en una jornada de al menos `breakRequiredAfterMin`
    const elapsed = minutesBetween(session.startedAt, session.endedAt);
    const closedBreaks = breaksList.filter((b) => b.endedAt !== null).length;
    if (policy.requireBreak && closedBreaks === 0 && elapsed >= policy.breakRequiredAfterMin) {
      out.set('SIN_COMIDA', { elapsedMinutes: elapsed, breakRequiredAfterMin: policy.breakRequiredAfterMin });
    }
  }
  return out;
}

/** Tipos que se recalculan con los valores efectivos de la jornada. */
export const DERIVED_INCIDENTS: readonly IncidentType[] = ['RETARDO', 'COMIDA_EXCEDIDA', 'SALIDA_ANTICIPADA', 'SIN_COMIDA'];

/**
 * Sincroniza las incidencias DERIVADAS de una jornada con sus valores efectivos:
 *  - falta y debería estar ⇒ se abre (idempotente);
 *  - está abierta con otros minutos ⇒ (solo en una corrección) se resuelve como CORRECTED y se abre la nueva;
 *  - está abierta y ya no aplica ⇒ (solo en una corrección) se resuelve como CORRECTED. Nunca se borra nada.
 * El kiosco no resuelve: solo abre lo que corresponde al cerrar la jornada.
 */
export async function syncDerivedIncidents(
  tx: Tx,
  ctx: TenantContext,
  sessionId: string,
  now: Date,
  opts: { detectedBy: 'KIOSK' | 'CORRECTION'; currentPolicy: () => Promise<EffectivePolicy>; correction?: { id: string; reason: string } },
) {
  const [s] = await tx.select().from(workSessions).where(eq(workSessions.id, sessionId));
  if (!s) return;
  const snapshot = s.policySnapshot as Partial<PolicySnapshot>;
  const policy = policyFor(snapshot, needsCurrentPolicy(snapshot) ? await opts.currentPolicy() : null);
  const shift = await loadShift(tx, s.shiftId);
  const list = await breaksOf(tx, [s.id]);
  const expected = expectedIncidents(s, shift, list, policy);
  const open = await tx.select().from(incidents).where(and(eq(incidents.workSessionId, s.id), eq(incidents.status, 'OPEN')));
  const base = { branchId: s.branchId, employeeId: s.employeeId, operationalDate: s.operationalDate, workSessionId: s.id, shiftId: s.shiftId };
  const resolution = opts.correction ? { resolution: 'CORRECTED' as const, reason: opts.correction.reason, at: now, correctionId: opts.correction.id } : null;

  for (const type of DERIVED_INCIDENTS) {
    const want = expected.get(type);
    const current = open.find((i) => i.type === type);
    const minutesKey = type === 'RETARDO' ? 'lateMinutes' : type === 'SALIDA_ANTICIPADA' ? 'earlyMinutes' : null;
    const changed = Boolean(current && want && minutesKey && (current.details as Record<string, unknown>)[minutesKey] !== want[minutesKey]);
    if (current && resolution && (!want || changed)) await resolveIncidents(tx, ctx, { workSessionId: s.id, types: [type] }, resolution);
    if (want && (!current || (changed && resolution))) await openIncident(tx, ctx, { ...base, type, details: want }, opts.detectedBy, now);
  }
}

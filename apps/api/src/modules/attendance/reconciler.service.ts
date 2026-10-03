import { and, eq, lte, sql } from 'drizzle-orm';
import { raisedCode } from '../../common/errors.js';
import type { Gate } from '../../common/tenancy/gate.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';
import { breaks, shifts, workSessions } from '../../db/schema/index.js';
import type { AuditService } from '../audit/audit.service.js';
import type { PoliciesService } from '../policies/policies.service.js';
import { type PolicySnapshot, type SessionRow, loadBranch, loadShift, openIncident } from './attendance-common.js';
import { firstCutoffAfter, minutesBetween } from './attendance-time.js';

export interface ReconcileResult {
  organizationId: string;
  absences: number;
  forgottenExits: number;
  longOpenSessions: number;
  openBreaks: number;
}

/**
 * Reconciliación periódica e IDEMPOTENTE (D-44, D-47, D-48, D-50). Nunca inventa una hora:
 *  - turno oficial terminado sin Entrada ⇒ FALTA (una sola por turno, garantizado por índice único);
 *  - jornada con turno abierta al primer corte operativo posterior al fin ⇒ REVIEW + SALIDA_OLVIDADA;
 *  - jornada sin turno abierta más de `max_open_session_minutes` ⇒ REVIEW + JORNADA_ABIERTA_EXCEDIDA;
 *  - si al pasar a revisión tenía una pausa abierta ⇒ REGRESO_COMIDA_FALTANTE.
 * Cada negocio se procesa en SU transacción y SU contexto (RLS activo; rol sin BYPASSRLS).
 */
export class ReconcilerService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly gate: Gate,
    private readonly audit: AuditService,
    private readonly policies: PoliciesService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  static systemContext(organizationId: string): TenantContext {
    return { organizationId, actor: { type: 'SYSTEM' } };
  }

  /** Todos los negocios activos; el error de uno no detiene a los demás. */
  async reconcileAll(): Promise<{ results: ReconcileResult[]; errors: { organizationId: string; error: string }[] }> {
    const results: ReconcileResult[] = [];
    const errors: { organizationId: string; error: string }[] = [];
    for (const organizationId of await this.gate.listActiveOrganizations()) {
      try {
        results.push(await this.reconcileOrganization(organizationId));
      } catch (error) {
        errors.push({ organizationId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { results, errors };
  }

  async reconcileOrganization(organizationId: string): Promise<ReconcileResult> {
    const ctx = ReconcilerService.systemContext(organizationId);
    const now = this.clock();
    return this.tenantDb.run(ctx, async (tx) => {
      // Dos ejecuciones simultáneas del mismo negocio se serializan (además de la idempotencia por índices).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('attendance.reconcile:' || ${organizationId}))`);
      const result: ReconcileResult = { organizationId, absences: 0, forgottenExits: 0, longOpenSessions: 0, openBreaks: 0 };

      // ── FALTA: turno OFICIAL terminado sin ninguna jornada ligada (D-43/D-44; D-62/D-63 excluyen cancelados y borradores)
      const missed = await tx
        .select()
        .from(shifts)
        .where(
          and(
            eq(shifts.status, 'SCHEDULED'),
            lte(shifts.endsAt, now),
            sql`EXISTS (SELECT 1 FROM scheduling.weekly_schedules w WHERE w.id = ${shifts.scheduleId} AND w.status = 'PUBLISHED')`,
            sql`NOT EXISTS (SELECT 1 FROM attendance.work_sessions ws WHERE ws.shift_id = ${shifts.id})`,
            // una FALTA anulada (D-66) no impide la que corresponda ahora (p. ej. turno reasignado o reprogramado)
            sql`NOT EXISTS (SELECT 1 FROM attendance.incidents i WHERE i.shift_id = ${shifts.id} AND i.type = 'FALTA' AND (i.resolution IS NULL OR i.resolution <> 'VOIDED'))`,
          ),
        );
      for (const shift of missed) {
        // Bloquea el turno y revalida: si en paralelo se canceló o reasignó, no se crea la falta (D-66). La guarda de la BD
        // (FALTA_NOT_APPLICABLE) es la última barrera; un savepoint evita que un turno invalide toda la reconciliación.
        const [still] = await tx
          .select({ id: shifts.id, operationalDate: shifts.operationalDate })
          .from(shifts)
          .where(and(eq(shifts.id, shift.id), eq(shifts.status, 'SCHEDULED'), eq(shifts.employeeId, shift.employeeId), eq(shifts.branchId, shift.branchId)))
          .for('share');
        if (!still) continue;
        const incident = await tx.transaction((sp) => openIncident(
          sp,
          ctx,
          {
            type: 'FALTA',
            branchId: shift.branchId,
            employeeId: shift.employeeId,
            shiftId: shift.id,
            operationalDate: still.operationalDate, // D-78: el día operativo del turno
            details: { startsAt: shift.startsAt, endsAt: shift.endsAt },
          },
          'RECONCILER',
          now,
        )).catch((error: unknown) => {
          if (raisedCode(error) === 'FALTA_NOT_APPLICABLE') return null;
          throw error;
        });
        if (!incident) continue;
        result.absences += 1;
        await this.audit.record(tx, ctx, {
          action: 'attendance.absence_recorded',
          entityType: 'shift',
          entityId: shift.id,
          branchId: shift.branchId,
          after: { incidentId: incident.id, employeeId: shift.employeeId, operationalDate: still.operationalDate },
        });
      }

      // ── Jornadas abiertas que ya deben revisarse
      const open = await tx.select().from(workSessions).where(eq(workSessions.status, 'OPEN'));
      for (const session of open) {
        const outcome = await this.reviewSessionTx(tx, ctx, session, now);
        if (outcome === 'SALIDA_OLVIDADA') result.forgottenExits += 1;
        if (outcome === 'JORNADA_ABIERTA_EXCEDIDA') result.longOpenSessions += 1;
        if (outcome && outcome !== 'NONE' && (await this.hadOpenBreak(tx, session.id))) result.openBreaks += 1;
      }
      return result;
    });
  }

  private async hadOpenBreak(tx: Tx, sessionId: string) {
    const rows = await tx.select({ id: breaks.id }).from(breaks).where(and(eq(breaks.workSessionId, sessionId), sql`${breaks.endedAt} IS NULL`));
    return rows.length > 0;
  }

  /**
   * ¿Esta jornada ABIERTA ya debe pasar a revisión? También se usa al identificarse el empleado (RN-OPE-05),
   * así una jornada vencida nunca deja "atorado" el kiosco aunque el proceso periódico no haya corrido.
   * La jornada queda SIN hora de salida (nunca se inventa).
   */
  async reviewSessionTx(tx: Tx, ctx: TenantContext, session: SessionRow, now: Date): Promise<'NONE' | 'SALIDA_OLVIDADA' | 'JORNADA_ABIERTA_EXCEDIDA'> {
    if (session.status !== 'OPEN') return 'NONE';
    const snapshot = session.policySnapshot as Partial<PolicySnapshot>;
    let type: 'SALIDA_OLVIDADA' | 'JORNADA_ABIERTA_EXCEDIDA' | null = null;
    let details: Record<string, unknown> = {};

    if (session.shiftId) {
      const shift = await loadShift(tx, session.shiftId);
      const branch = await loadBranch(tx, session.branchId);
      const cutoff = snapshot.operationalCutoff ?? (await this.policies.getEffectiveTx(tx, ctx, { branchId: session.branchId })).policy.operationalCutoff;
      if (shift) {
        const dueAt = firstCutoffAfter(shift.endsAt, branch.timezone, cutoff);
        if (now.getTime() >= dueAt.getTime()) {
          type = 'SALIDA_OLVIDADA';
          details = { shiftEndsAt: shift.endsAt, cutoffAt: dueAt, cutoff };
        }
      }
    } else {
      const limit =
        snapshot.maxOpenSessionMinutes ??
        (await this.policies.getEffectiveTx(tx, ctx, { branchId: session.branchId, employeeId: session.employeeId })).policy.maxOpenSessionMinutes;
      const elapsed = minutesBetween(session.startedAt, now);
      if (elapsed >= limit) {
        type = 'JORNADA_ABIERTA_EXCEDIDA';
        details = { limitMinutes: limit, elapsedMinutes: elapsed };
      }
    }
    if (!type) return 'NONE';

    const [updated] = await tx
      .update(workSessions)
      .set({ status: 'REVIEW', version: sql`${workSessions.version} + 1` })
      .where(and(eq(workSessions.id, session.id), eq(workSessions.status, 'OPEN')))
      .returning();
    if (!updated) return 'NONE'; // otra ejecución ya la marcó
    const base = { branchId: session.branchId, employeeId: session.employeeId, operationalDate: session.operationalDate, workSessionId: session.id, shiftId: session.shiftId };
    await openIncident(tx, ctx, { ...base, type, details }, 'RECONCILER', now);
    const [openBreak] = await tx.select().from(breaks).where(and(eq(breaks.workSessionId, session.id), sql`${breaks.endedAt} IS NULL`));
    if (openBreak) {
      await openIncident(tx, ctx, { ...base, type: 'REGRESO_COMIDA_FALTANTE', details: { breakId: openBreak.id, breakStartedAt: openBreak.startedAt } }, 'RECONCILER', now);
    }
    await this.audit.record(tx, ctx, {
      action: 'attendance.session_flagged',
      entityType: 'work_session',
      entityId: session.id,
      branchId: session.branchId,
      before: { status: 'OPEN' },
      after: { status: 'REVIEW', incident: type, openBreak: Boolean(openBreak), endedAt: null },
    });
    return type;
  }
}

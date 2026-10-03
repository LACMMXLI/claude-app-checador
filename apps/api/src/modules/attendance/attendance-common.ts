import { and, asc, eq, gt, gte, inArray, isNull, lte, ne, notExists, or, sql } from 'drizzle-orm';
import { DomainError } from '../../common/errors.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx } from '../../common/tenancy/tenant-db.js';
import { effectiveTimezone } from '../../common/time.js';
import {
  branches,
  breaks,
  employeeBranchAssignments,
  incidents,
  organizations,
  shifts,
  weeklySchedules,
  workSessions,
} from '../../db/schema/index.js';
import type { EffectivePolicy } from '../policies/policy.js';
import { localView } from '../scheduling/shift-time.js';
import { sessionMetrics } from './attendance-time.js';

export type SessionRow = typeof workSessions.$inferSelect;
export type BreakRow = typeof breaks.$inferSelect;
export type IncidentRow = typeof incidents.$inferSelect;
export type ShiftRow = typeof shifts.$inferSelect;

export type PunchAction = 'CLOCK_IN' | 'BREAK_START' | 'BREAK_END' | 'CLOCK_OUT';
export const PUNCH_ACTIONS: readonly PunchAction[] = ['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT'];

export type IncidentType =
  | 'RETARDO'
  | 'FALTA'
  | 'SIN_TURNO_PROGRAMADO'
  | 'SIN_ASIGNACION_SUCURSAL'
  | 'TURNO_EN_OTRA_SUCURSAL'
  | 'ENTRADA_FALTANTE'
  | 'SALIDA_OLVIDADA'
  | 'JORNADA_ABIERTA_EXCEDIDA'
  | 'REGRESO_COMIDA_FALTANTE'
  | 'COMIDA_EXCEDIDA'
  | 'SALIDA_ANTICIPADA'
  | 'SIN_COMIDA';

/** Incidencias que significan "esta jornada requiere corrección" (D-47, D-48, D-50). */
export const REVIEW_INCIDENTS: readonly IncidentType[] = ['SALIDA_OLVIDADA', 'JORNADA_ABIERTA_EXCEDIDA', 'REGRESO_COMIDA_FALTANTE'];

/** Copia de la política efectiva con la que se evaluó la jornada (RN-CAL-05). */
export interface PolicySnapshot {
  entryToleranceMin: number;
  exitToleranceMin: number;
  earlyEntryWindowMin: number;
  absentAfterMin: number;
  operationalCutoff: string;
  maxOpenSessionMinutes: number;
  maxBreaks: number;
  breakAllowedMin: number;
  breakToleranceMin: number;
  /** Fase 4 (precisión D): la jornada congela todo lo necesario para recalcular sus reglas después. */
  requireBreak: boolean;
  breakRequiredAfterMin: number;
}

export const snapshotOf = (p: EffectivePolicy): PolicySnapshot => ({
  entryToleranceMin: p.entryToleranceMin,
  exitToleranceMin: p.exitToleranceMin,
  earlyEntryWindowMin: p.earlyEntryWindowMin,
  absentAfterMin: p.absentAfterMin,
  operationalCutoff: p.operationalCutoff,
  maxOpenSessionMinutes: p.maxOpenSessionMinutes,
  maxBreaks: p.maxBreaks,
  breakAllowedMin: p.breakAllowedMin,
  breakToleranceMin: p.breakToleranceMin,
  requireBreak: p.requireBreak,
  breakRequiredAfterMin: p.breakRequiredAfterMin,
});

export async function loadBranch(tx: Tx, branchId: string) {
  const [row] = await tx
    .select({ id: branches.id, name: branches.name, isActive: branches.isActive, branchTz: branches.timezone, orgTz: organizations.timezone })
    .from(branches)
    .innerJoin(organizations, eq(organizations.id, branches.organizationId))
    .where(eq(branches.id, branchId));
  if (!row) throw new DomainError('BRANCH_NOT_FOUND');
  return { id: row.id, name: row.name, isActive: row.isActive, timezone: effectiveTimezone(row.branchTz, row.orgTz) };
}

/** ¿El empleado tiene una asignación vigente en esa sucursal en esa fecha? (D-17: si no, se marca, no se bloquea). */
export async function isAssignedOn(tx: Tx, employeeId: string, branchId: string, date: string): Promise<boolean> {
  const rows = await tx
    .select({ id: employeeBranchAssignments.id })
    .from(employeeBranchAssignments)
    .where(
      and(
        eq(employeeBranchAssignments.employeeId, employeeId),
        eq(employeeBranchAssignments.branchId, branchId),
        lte(employeeBranchAssignments.validFrom, date),
        or(isNull(employeeBranchAssignments.validTo), gte(employeeBranchAssignments.validTo, date)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Condición SQL: el turno es OFICIAL (D-34, D-62, D-63): SCHEDULED y de un horario PUBLISHED. */
const official = () =>
  and(
    eq(shifts.status, 'SCHEDULED'),
    sql`EXISTS (SELECT 1 FROM scheduling.weekly_schedules w WHERE w.id = ${shifts.scheduleId} AND w.status = 'PUBLISHED')`,
  );
const withoutSession = () =>
  notExists(sql`(SELECT 1 FROM attendance.work_sessions ws WHERE ws.shift_id = ${shifts.id})`);

/**
 * D-35 · Turnos oficiales del empleado cuya ventana contiene `now`: desde `inicio − early_entry_window_min`
 * hasta el FIN del turno, que todavía no tienen jornada. `branch = { id }` busca en esa sucursal;
 * `{ exceptId }` busca en cualquier OTRA (solo para la marca informativa de D-36).
 * Si hay varios, gana el de inicio más cercano a `now` (desempate: el que empieza antes).
 */
export async function shiftsInWindow(
  tx: Tx,
  employeeId: string,
  branch: { id: string } | { exceptId: string },
  now: Date,
  earlyEntryWindowMin: number,
): Promise<ShiftRow[]> {
  const earliestStart = new Date(now.getTime() + earlyEntryWindowMin * 60_000);
  const rows = await tx
    .select()
    .from(shifts)
    .where(
      and(
        eq(shifts.employeeId, employeeId),
        'id' in branch ? eq(shifts.branchId, branch.id) : ne(shifts.branchId, branch.exceptId),
        official(),
        withoutSession(),
        lte(shifts.startsAt, earliestStart),
        gt(shifts.endsAt, now),
      ),
    )
    .orderBy(asc(shifts.startsAt));
  return rows.sort(
    (a, b) => Math.abs(a.startsAt.getTime() - now.getTime()) - Math.abs(b.startsAt.getTime() - now.getTime()) || a.startsAt.getTime() - b.startsAt.getTime(),
  );
}

/** Turnos oficiales de la misma sucursal y día que ya terminaron sin jornada (marca ENTRADA_FALTANTE, RN-EVT-11). */
export async function endedShiftsWithoutSession(tx: Tx, employeeId: string, branchId: string, businessDate: string, now: Date) {
  return tx
    .select()
    .from(shifts)
    .where(and(eq(shifts.employeeId, employeeId), eq(shifts.branchId, branchId), eq(shifts.businessDate, businessDate), official(), withoutSession(), lte(shifts.endsAt, now)));
}

/** Próximo turno oficial (para mostrarle al empleado en el kiosco; nunca borradores — D-34). */
export async function nextOfficialShift(tx: Tx, employeeId: string, branchId: string, now: Date): Promise<ShiftRow | null> {
  const [row] = await tx
    .select()
    .from(shifts)
    .where(and(eq(shifts.employeeId, employeeId), eq(shifts.branchId, branchId), official(), gt(shifts.endsAt, now), lte(shifts.startsAt, new Date(now.getTime() + 24 * 3_600_000))))
    .orderBy(asc(shifts.startsAt))
    .limit(1);
  return row ?? null;
}

export async function loadShift(tx: Tx, shiftId: string | null): Promise<(ShiftRow & { scheduleStatus: string }) | null> {
  if (!shiftId) return null;
  const [row] = await tx
    .select({ shift: shifts, scheduleStatus: weeklySchedules.status })
    .from(shifts)
    .innerJoin(weeklySchedules, eq(weeklySchedules.id, shifts.scheduleId))
    .where(eq(shifts.id, shiftId));
  return row ? { ...row.shift, scheduleStatus: row.scheduleStatus } : null;
}

export async function breaksOf(tx: Tx, sessionIds: string[]): Promise<BreakRow[]> {
  if (sessionIds.length === 0) return [];
  return tx.select().from(breaks).where(inArray(breaks.workSessionId, sessionIds)).orderBy(asc(breaks.sequence));
}

// ── incidencias ──────────────────────────────────────────────────────────────
export interface NewIncident {
  type: IncidentType;
  branchId: string;
  employeeId: string;
  operationalDate: string;
  workSessionId?: string | null;
  shiftId?: string | null;
  details?: Record<string, unknown>;
}

/** Abre una incidencia de forma IDEMPOTENTE (índices únicos: una abierta por tipo y jornada; una FALTA por turno). */
export async function openIncident(
  tx: Tx,
  ctx: TenantContext,
  incident: NewIncident,
  detectedBy: 'KIOSK' | 'RECONCILER' | 'CORRECTION',
  detectedAt: Date,
): Promise<IncidentRow | null> {
  const [row] = await tx
    .insert(incidents)
    .values({
      organizationId: ctx.organizationId,
      branchId: incident.branchId,
      employeeId: incident.employeeId,
      operationalDate: incident.operationalDate,
      workSessionId: incident.workSessionId ?? null,
      shiftId: incident.shiftId ?? null,
      type: incident.type,
      details: incident.details ?? {},
      detectedBy,
      detectedAt,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Resuelve (sin borrar) las incidencias ABIERTAS que coinciden. Devuelve las resueltas. */
export async function resolveIncidents(
  tx: Tx,
  ctx: TenantContext,
  where: { workSessionId?: string; shiftId?: string; types: readonly IncidentType[] },
  resolution: { resolution: 'CORRECTED' | 'JUSTIFIED' | 'CONFIRMED' | 'DISMISSED' | 'VOIDED'; reason: string; at: Date; correctionId?: string | null },
): Promise<IncidentRow[]> {
  if (where.types.length === 0) return [];
  return tx
    .update(incidents)
    .set({
      status: 'RESOLVED',
      resolution: resolution.resolution,
      resolvedAt: resolution.at,
      resolvedBy: ctx.actor.userId ?? null,
      resolutionReason: resolution.reason,
      resolutionCorrectionId: resolution.correctionId ?? null,
      // origen de la resolución (D-66): VOIDED solo el sistema; CORRECTED solo una corrección; el resto, una persona
      resolutionSource: resolution.resolution === 'VOIDED' ? 'SYSTEM' : resolution.resolution === 'CORRECTED' ? 'CORRECTION' : 'USER',
      version: sql`${incidents.version} + 1`,
    })
    .where(
      and(
        eq(incidents.status, 'OPEN'),
        inArray(incidents.type, [...where.types]),
        where.workSessionId ? eq(incidents.workSessionId, where.workSessionId) : undefined,
        where.shiftId ? eq(incidents.shiftId, where.shiftId) : undefined,
      ),
    )
    .returning();
}

// ── vistas ───────────────────────────────────────────────────────────────────
export function shiftSummary(shift: (ShiftRow & { scheduleStatus?: string }) | null, branchName?: string) {
  if (!shift) return null;
  return {
    id: shift.id,
    branchId: shift.branchId,
    branchName: branchName ?? null,
    businessDate: shift.businessDate,
    startsAt: shift.startsAt,
    endsAt: shift.endsAt,
    timezone: shift.timezoneSnapshot,
    ...localView(shift),
    scheduledMinutes: shift.scheduledMinutes,
    status: shift.status,
    scheduleStatus: shift.scheduleStatus ?? null,
  };
}

export function breakView(b: BreakRow) {
  return {
    id: b.id,
    sequence: b.sequence,
    startedAt: b.startedAt,
    endedAt: b.endedAt,
    durationMinutes: b.durationMinutes,
    allowedMinutes: b.allowedMinutes,
    toleranceMinutes: b.toleranceMinutes,
    exceededMinutes: b.exceededMinutes,
    origin: b.origin,
    version: b.version,
  };
}

export function sessionView(s: SessionRow, breaksList: readonly BreakRow[], shift: ShiftRow | null, now: Date) {
  return {
    id: s.id,
    branchId: s.branchId,
    employeeId: s.employeeId,
    shiftId: s.shiftId,
    operationalDate: s.operationalDate,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    status: s.status,
    origin: s.origin,
    version: s.version,
    onBreak: breaksList.some((b) => b.endedAt === null),
    breaks: breaksList.map(breakView),
    metrics: sessionMetrics(s, shift, breaksList, now),
  };
}

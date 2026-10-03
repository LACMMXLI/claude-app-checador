import { and, eq, ne, sql } from 'drizzle-orm';
import { DomainError, isPgError, raisedCode } from '../../common/errors.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';
import { type Fold, localToUtc } from '../../common/zoned-time.js';
import { breaks, corrections, employees, incidents, shifts, workSessions } from '../../db/schema/index.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AccessProfile } from '../auth/rbac.service.js';
import type { PoliciesService } from '../policies/policies.service.js';
import {
  type BreakRow,
  type IncidentType,
  type PolicySnapshot,
  type SessionRow,
  breaksOf,
  isAssignedOn,
  loadBranch,
  loadShift,
  openIncident,
  resolveIncidents,
  snapshotOf,
} from './attendance-common.js';
import { type OperationalCalendar, operationalDateIn } from '../../common/operational-day.js';
import { syncDerivedIncidents } from './session-rules.js';

/** Hora local en la zona de la sucursal donde ocurrió la jornada (DST explícito, como en planificación). */
export interface LocalInstant {
  date: string;
  time: string;
  fold?: Fold;
}

/** Hora capturada en local, o un instante ya resuelto (aprobación de una solicitud: se aplica EXACTAMENTE lo enviado). */
export type When = LocalInstant | { instant: Date };

export type CorrectionInput =
  | { action: 'SET_CLOCK_IN'; at: When }
  | { action: 'SET_CLOCK_OUT'; at: When }
  | { action: 'SET_BREAK_START'; breakId: string; at: When }
  | { action: 'SET_BREAK_END'; breakId: string; at: When }
  | { action: 'LINK_SHIFT'; shiftId: string }
  | { action: 'UNLINK_SHIFT' }
  | { action: 'ADD_BREAK'; start: When; end: When };

export interface CreateSessionInput {
  employeeId: string;
  branchId: string;
  shiftId?: string | null;
  start: When;
  end: When;
  incidentId?: string | null;
}

/**
 * Corrección de asistencia (D-51 … D-53): módulo separado de la planificación (nunca modifica turnos).
 * Acciones de dominio controladas — no un "editar cualquier campo". El evento físico jamás se toca:
 * cambia el valor EFECTIVO de la jornada/pausa y queda una fila solo-agregar con original, corregido,
 * antes/después, usuario, fecha y motivo. Alcance por la sucursal donde OCURRIÓ la jornada (D-18) y nunca
 * la propia (también lo impide un trigger).
 */
export class CorrectionsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly policies: PoliciesService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private authorize(access: AccessProfile, permission: string, branchId: string, employeeId: string, notFound: string) {
    if (!access.can('attendance.view', branchId) && !access.can(permission, branchId)) throw new DomainError(notFound);
    if (!access.can(permission, branchId)) throw new DomainError('FORBIDDEN', { permission });
    if (access.employeeId && access.employeeId === employeeId) throw new DomainError('SELF_CORRECTION_FORBIDDEN');
  }

  private requireReason(reason: string | undefined): string {
    const r = reason?.trim();
    if (!r) throw new DomainError('REASON_REQUIRED');
    return r;
  }

  private toInstant(at: When, timezone: string, now: Date): Date {
    const instant = 'instant' in at ? at.instant : localToUtc(at.date, at.time, timezone, at.fold);
    if (instant.getTime() > now.getTime()) throw new DomainError('CORRECTION_IN_FUTURE');
    return instant;
  }

  private async snapshot(tx: Tx, sessionId: string) {
    const [s] = await tx.select().from(workSessions).where(eq(workSessions.id, sessionId));
    const list = await breaksOf(tx, [sessionId]);
    return {
      shiftId: s!.shiftId,
      operationalDate: s!.operationalDate,
      startedAt: s!.startedAt,
      endedAt: s!.endedAt,
      status: s!.status,
      breaks: list.map((b) => ({ id: b.id, sequence: b.sequence, startedAt: b.startedAt, endedAt: b.endedAt, durationMinutes: b.durationMinutes, exceededMinutes: b.exceededMinutes })),
    };
  }

  /** Ninguna otra jornada del empleado se cruza con [inicio, fin] (las abiertas cuentan como su instante de inicio). */
  private async assertNoOverlap(tx: Tx, employeeId: string, excludeId: string | null, start: Date, end: Date | null) {
    const others = await tx
      .select()
      .from(workSessions)
      .where(and(eq(workSessions.employeeId, employeeId), excludeId ? ne(workSessions.id, excludeId) : undefined));
    const hi = (end ?? start).getTime();
    for (const o of others) {
      const oStart = o.startedAt.getTime();
      const oEnd = (o.endedAt ?? o.startedAt).getTime();
      const overlaps = o.endedAt ? start.getTime() < oEnd && hi > oStart : oStart >= start.getTime() && oStart < hi;
      if (overlaps || (o.endedAt === null && end === null && oStart === start.getTime())) {
        throw new DomainError('SESSION_OVERLAP', { otherSessionId: o.id });
      }
    }
  }

  /** Recalcula las incidencias DERIVADAS (retardo, comida excedida, salida anticipada, sin comida) con los valores efectivos. */
  private recompute(tx: Tx, ctx: TenantContext, sessionId: string, now: Date, correctionId: string, reason: string) {
    return syncDerivedIncidents(tx, ctx, sessionId, now, {
      detectedBy: 'CORRECTION',
      correction: { id: correctionId, reason },
      currentPolicy: async () => {
        const [s] = await tx.select().from(workSessions).where(eq(workSessions.id, sessionId));
        return (await this.policies.getEffectiveTx(tx, ctx, { branchId: s!.branchId, employeeId: s!.employeeId })).policy;
      },
    });
  }

  private async insertCorrection(
    tx: Tx,
    ctx: TenantContext,
    s: SessionRow,
    action: string,
    values: { breakId?: string | null; incidentId?: string | null; requestId?: string | null; original: unknown; corrected: unknown; before: unknown; after: unknown; reason: string },
  ) {
    const [row] = await tx
      .insert(corrections)
      .values({
        organizationId: ctx.organizationId,
        branchId: s.branchId,
        employeeId: s.employeeId,
        workSessionId: s.id,
        breakId: values.breakId ?? null,
        incidentId: values.incidentId ?? null,
        action,
        originalValue: values.original as object,
        correctedValue: values.corrected as object,
        before: values.before as object,
        after: values.after as object,
        reason: values.reason,
        correctedBy: ctx.actor.userId!,
        correctedAt: this.clock(),
        requestId: values.requestId ?? null,
      })
      .returning();
    return row!;
  }

  /**
   * D-78 · Calendario de una jornada SIN turno: zona de la sucursal y la hora de corte CONGELADA en la jornada al abrirse
   * (los cambios de política aplican hacia adelante); las jornadas antiguas sin ese dato usan el corte vigente.
   */
  private async sessionCalendar(tx: Tx, ctx: TenantContext, s: { branchId: string; policySnapshot: unknown }): Promise<OperationalCalendar> {
    const calendar = await this.policies.calendarTx(tx, ctx, s.branchId);
    const cutoff = (s.policySnapshot as Partial<PolicySnapshot>).operationalCutoff;
    return cutoff ? { ...calendar, cutoff } : calendar;
  }

  mapDbError(error: unknown): never {
    if (error instanceof DomainError) throw error;
    if (isPgError(error, '23P01')) throw new DomainError('SESSION_OVERLAP');
    if (isPgError(error, '23505', 'work_sessions_one_per_shift')) throw new DomainError('SHIFT_ALREADY_HAS_SESSION');
    if (isPgError(error, '23503', 'work_session_shift_fk')) throw new DomainError('SHIFT_NOT_LINKABLE');
    const raised = raisedCode(error);
    if (raised) throw new DomainError(raised);
    throw error;
  }

  /** Aplica UNA acción de corrección sobre una jornada. Concurrencia optimista con la versión de la jornada. */
  async apply(ctx: TenantContext, access: AccessProfile, sessionId: string, expectedVersion: number, input: CorrectionInput, reasonInput: string) {
    try {
      return await this.tenantDb.run(ctx, (tx) => this.applyTx(tx, ctx, access, sessionId, expectedVersion, input, reasonInput));
    } catch (error) {
      return this.mapDbError(error);
    }
  }

  /**
   * Núcleo transaccional de una corrección. Lo usan la corrección directa y la APROBACIÓN de una solicitud (D-71):
   * mismas validaciones, mismo resultado; con `requestId` la corrección queda ligada a la solicitud.
   */
  async applyTx(
    tx: Tx,
    ctx: TenantContext,
    access: AccessProfile,
    sessionId: string,
    expectedVersion: number,
    input: CorrectionInput,
    reasonInput: string,
    extra: { requestId?: string; notFound?: string } = {},
  ) {
    const reason = this.requireReason(reasonInput);
    if (!ctx.actor.userId) throw new DomainError('FORBIDDEN');
    const [s] = await tx.select().from(workSessions).where(eq(workSessions.id, sessionId)).for('update');
    if (!s) throw new DomainError(extra.notFound ?? 'SESSION_NOT_FOUND');
    this.authorize(access, 'attendance.correction.apply', s.branchId, s.employeeId, extra.notFound ?? 'SESSION_NOT_FOUND');
    if (s.version !== expectedVersion) throw new DomainError('SESSION_VERSION_CONFLICT', { currentVersion: s.version });
    const now = this.clock();
    const branch = await loadBranch(tx, s.branchId);
    const list = await breaksOf(tx, [s.id]);
    const before = await this.snapshot(tx, s.id);
    let original: unknown;
    let corrected: unknown;
    let breakId: string | null = null;
    let resolveTypes: IncidentType[] = [];
    let openType: IncidentType | null = null;
    let resolveFaltaShiftId: string | null = null;

    switch (input.action) {
      case 'SET_CLOCK_IN': {
        const at = this.toInstant(input.at, branch.timezone, now);
        if (s.endedAt && at.getTime() > s.endedAt.getTime()) throw new DomainError('CORRECTION_ORDER_INVALID', { field: 'clockIn' });
        if (list.length && at.getTime() > list[0]!.startedAt.getTime()) throw new DomainError('CORRECTION_ORDER_INVALID', { field: 'clockIn' });
        await this.assertNoOverlap(tx, s.employeeId, s.id, at, s.endedAt);
        original = { startedAt: s.startedAt };
        corrected = { startedAt: at };
        // D-78: ligada a turno conserva el día del turno; sin turno, el de la nueva Entrada (corte congelado en la jornada)
        await tx
          .update(workSessions)
          .set({ startedAt: at, operationalDate: s.shiftId ? s.operationalDate : operationalDateIn(at, await this.sessionCalendar(tx, ctx, s)), version: s.version + 1 })
          .where(eq(workSessions.id, s.id));
        break;
      }
      case 'SET_CLOCK_OUT': {
        const at = this.toInstant(input.at, branch.timezone, now);
        if (list.some((b) => b.endedAt === null)) throw new DomainError('BREAK_OPEN'); // primero se corrige el regreso (D-50)
        const lastBreakEnd = Math.max(0, ...list.map((b) => b.endedAt!.getTime()));
        if (at.getTime() < s.startedAt.getTime() || at.getTime() < lastBreakEnd) throw new DomainError('CORRECTION_ORDER_INVALID', { field: 'clockOut' });
        await this.assertNoOverlap(tx, s.employeeId, s.id, s.startedAt, at);
        original = { endedAt: s.endedAt, status: s.status };
        corrected = { endedAt: at, status: 'CLOSED' };
        await tx.update(workSessions).set({ endedAt: at, status: 'CLOSED', version: s.version + 1 }).where(eq(workSessions.id, s.id));
        resolveTypes = ['SALIDA_OLVIDADA', 'JORNADA_ABIERTA_EXCEDIDA'];
        break;
      }
      case 'SET_BREAK_START':
      case 'SET_BREAK_END': {
        const idx = list.findIndex((b) => b.id === input.breakId);
        if (idx < 0) throw new DomainError('BREAK_NOT_FOUND');
        const brk: BreakRow = list[idx]!;
        const prev = list[idx - 1];
        const next = list[idx + 1];
        const at = this.toInstant(input.at, branch.timezone, now);
        const start = input.action === 'SET_BREAK_START' ? at : brk.startedAt;
        const end = input.action === 'SET_BREAK_END' ? at : brk.endedAt;
        const invalid =
          start.getTime() < s.startedAt.getTime() ||
          (end !== null && end.getTime() < start.getTime()) ||
          (prev?.endedAt && start.getTime() < prev.endedAt.getTime()) ||
          (next && (end ?? start).getTime() > next.startedAt.getTime()) ||
          (s.endedAt && (end ?? start).getTime() > s.endedAt.getTime());
        if (invalid) throw new DomainError('CORRECTION_ORDER_INVALID', { field: input.action === 'SET_BREAK_START' ? 'breakStart' : 'breakEnd' });
        breakId = brk.id;
        original = input.action === 'SET_BREAK_START' ? { startedAt: brk.startedAt } : { endedAt: brk.endedAt };
        corrected = input.action === 'SET_BREAK_START' ? { startedAt: at } : { endedAt: at };
        await tx
          .update(breaks)
          .set({ ...(input.action === 'SET_BREAK_START' ? { startedAt: at } : { endedAt: at }), version: brk.version + 1 })
          .where(eq(breaks.id, brk.id));
        await tx.update(workSessions).set({ version: s.version + 1 }).where(eq(workSessions.id, s.id));
        if (input.action === 'SET_BREAK_END' && brk.endedAt === null) resolveTypes = ['REGRESO_COMIDA_FALTANTE'];
        break;
      }
      case 'ADD_BREAK': {
        // D-69: pausa omitida — sin evento físico; dentro de la jornada, sin cruzarse con otras pausas, sin horas futuras
        const start = this.toInstant(input.start, branch.timezone, now);
        const end = this.toInstant(input.end, branch.timezone, now);
        if (end.getTime() <= start.getTime()) throw new DomainError('CORRECTION_ORDER_INVALID', { field: 'breakEnd' });
        if (start.getTime() < s.startedAt.getTime() || (s.endedAt && end.getTime() > s.endedAt.getTime())) {
          throw new DomainError('CORRECTION_ORDER_INVALID', { field: 'breakStart' });
        }
        if (list.some((b) => b.endedAt === null)) throw new DomainError('BREAK_OPEN');
        if (list.some((b) => start.getTime() < b.endedAt!.getTime() && end.getTime() > b.startedAt.getTime())) throw new DomainError('BREAK_OVERLAP');
        const snap = s.policySnapshot as Partial<PolicySnapshot>;
        const current = snap.breakAllowedMin === undefined || snap.breakToleranceMin === undefined || snap.maxBreaks === undefined
          ? (await this.policies.getEffectiveTx(tx, ctx, { branchId: s.branchId, employeeId: s.employeeId })).policy
          : null;
        const maxBreaks = snap.maxBreaks ?? current!.maxBreaks;
        const [added] = await tx
          .insert(breaks)
          .values({
            organizationId: ctx.organizationId,
            workSessionId: s.id,
            sequence: Math.max(0, ...list.map((b) => b.sequence)) + 1,
            startedAt: start,
            endedAt: end,
            allowedMinutes: snap.breakAllowedMin ?? current!.breakAllowedMin,
            toleranceMinutes: snap.breakToleranceMin ?? current!.breakToleranceMin,
            origin: 'CORRECTION',
          })
          .returning();
        await tx.update(workSessions).set({ version: s.version + 1 }).where(eq(workSessions.id, s.id));
        breakId = added!.id;
        original = null;
        corrected = { breakStartedAt: start, breakEndedAt: end, exceedsMaxBreaks: list.length + 1 > maxBreaks };
        break;
      }
      case 'LINK_SHIFT': {
        if (s.shiftId) throw new DomainError('SESSION_ALREADY_LINKED');
        const shift = await loadShift(tx, input.shiftId);
        if (!shift || shift.employeeId !== s.employeeId || shift.branchId !== s.branchId) throw new DomainError('SHIFT_NOT_LINKABLE');
        if (shift.status !== 'SCHEDULED' || shift.scheduleStatus !== 'PUBLISHED') throw new DomainError('SHIFT_NOT_OFFICIAL');
        original = { shiftId: null, operationalDate: s.operationalDate };
        // D-78: la jornada ligada toma el día operativo del turno
        corrected = { shiftId: shift.id, operationalDate: shift.operationalDate };
        await tx.update(workSessions).set({ shiftId: shift.id, operationalDate: shift.operationalDate, version: s.version + 1 }).where(eq(workSessions.id, s.id));
        resolveTypes = ['SIN_TURNO_PROGRAMADO', 'ENTRADA_FALTANTE'];
        resolveFaltaShiftId = shift.id;
        break;
      }
      case 'UNLINK_SHIFT': {
        if (!s.shiftId) throw new DomainError('SESSION_NOT_LINKED');
        const opDate = operationalDateIn(s.startedAt, await this.sessionCalendar(tx, ctx, s));
        original = { shiftId: s.shiftId, operationalDate: s.operationalDate };
        corrected = { shiftId: null, operationalDate: opDate };
        await tx.update(workSessions).set({ shiftId: null, operationalDate: opDate, version: s.version + 1 }).where(eq(workSessions.id, s.id));
        openType = 'SIN_TURNO_PROGRAMADO';
        break;
      }
      default:
        throw new DomainError('VALIDATION_ERROR');
    }

    const after = await this.snapshot(tx, s.id);
    const correction = await this.insertCorrection(tx, ctx, s, input.action, { breakId, original, corrected, before, after, reason, requestId: extra.requestId });
    const resolved = { resolution: 'CORRECTED' as const, reason, at: now, correctionId: correction.id };
    await resolveIncidents(tx, ctx, { workSessionId: s.id, types: resolveTypes }, resolved);
    if (resolveFaltaShiftId) await resolveIncidents(tx, ctx, { shiftId: resolveFaltaShiftId, types: ['FALTA'] }, resolved);
    const [current] = await tx.select().from(workSessions).where(eq(workSessions.id, s.id));
    if (openType) {
      await openIncident(tx, ctx, { type: openType, branchId: s.branchId, employeeId: s.employeeId, operationalDate: current!.operationalDate, workSessionId: s.id }, 'CORRECTION', now);
    }
    await this.recompute(tx, ctx, s.id, now, correction.id, reason);
    await this.audit.record(tx, ctx, {
      action: 'attendance.corrected',
      entityType: 'work_session',
      entityId: s.id,
      branchId: s.branchId,
      before,
      after: { ...after, correctionId: correction.id, correctionAction: input.action, requestId: extra.requestId ?? null },
      reason,
    });
    if (input.action === 'ADD_BREAK') {
      await this.audit.record(tx, ctx, { action: 'attendance.break_added', entityType: 'work_session', entityId: s.id, branchId: s.branchId, after: corrected, reason });
    }
    return { correctionId: correction.id, session: { ...after, id: s.id, version: current!.version } };
  }

  /**
   * D-53: el administrador demuestra que sí se trabajó (p. ej. un turno con FALTA, o sin internet — RN-EVT-13):
   * se CREA la jornada efectiva por corrección (sin eventos físicos falsos) y la FALTA queda resuelta, nunca borrada.
   */
  async createSession(ctx: TenantContext, access: AccessProfile, input: CreateSessionInput, reasonInput: string) {
    this.requireReason(reasonInput);
    this.authorize(access, 'attendance.correction.apply', input.branchId, input.employeeId, 'BRANCH_NOT_FOUND');
    try {
      return await this.tenantDb.run(ctx, (tx) => this.createSessionTx(tx, ctx, access, input, reasonInput));
    } catch (error) {
      return this.mapDbError(error);
    }
  }

  /**
   * Núcleo de CREATE_SESSION (corrección directa o aprobación de solicitud). Con turno (precisión C): se BLOQUEA el
   * turno y se revalida que siga oficial, del empleado y de la sucursal, y sin jornada; su FALTA abierta queda CORRECTED
   * y NO se genera SIN_TURNO_PROGRAMADO. Sin turno (D-72): se generan SIN_TURNO_PROGRAMADO y, si aplica, SIN_ASIGNACION_SUCURSAL.
   */
  async createSessionTx(tx: Tx, ctx: TenantContext, access: AccessProfile, input: CreateSessionInput, reasonInput: string, extra: { requestId?: string } = {}) {
    const reason = this.requireReason(reasonInput);
    if (!ctx.actor.userId) throw new DomainError('FORBIDDEN');
    this.authorize(access, 'attendance.correction.apply', input.branchId, input.employeeId, 'BRANCH_NOT_FOUND');
    const now = this.clock();
    const branch = await loadBranch(tx, input.branchId);
    const [employee] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.id, input.employeeId)).for('update');
    if (!employee) throw new DomainError('EMPLOYEE_NOT_FOUND');
    const start = this.toInstant(input.start, branch.timezone, now);
    const end = this.toInstant(input.end, branch.timezone, now);
    if (end.getTime() < start.getTime()) throw new DomainError('CORRECTION_ORDER_INVALID', { field: 'clockOut' });
    const { policy } = await this.policies.getEffectiveTx(tx, ctx, { branchId: input.branchId, employeeId: input.employeeId });
    let shiftId: string | null = null;
    let opDate = operationalDateIn(start, await this.policies.calendarTx(tx, ctx, input.branchId));
    if (input.shiftId) {
      await tx.select({ id: shifts.id }).from(shifts).where(eq(shifts.id, input.shiftId)).for('update');
      const shift = await loadShift(tx, input.shiftId);
      if (!shift || shift.employeeId !== input.employeeId || shift.branchId !== input.branchId) throw new DomainError('SHIFT_NOT_LINKABLE');
      if (shift.status !== 'SCHEDULED' || shift.scheduleStatus !== 'PUBLISHED') throw new DomainError('SHIFT_NOT_OFFICIAL');
      shiftId = shift.id;
      opDate = shift.operationalDate; // D-78
    }
    await this.assertNoOverlap(tx, input.employeeId, null, start, end);
    const [session] = await tx
      .insert(workSessions)
      .values({
        organizationId: ctx.organizationId,
        branchId: input.branchId,
        employeeId: input.employeeId,
        shiftId,
        operationalDate: opDate,
        startedAt: start,
        endedAt: end,
        status: 'CLOSED',
        origin: 'CORRECTION',
        policySnapshot: snapshotOf(policy),
        createdBy: ctx.actor.userId,
      })
      .returning();
    const after = await this.snapshot(tx, session!.id);
    let incidentId: string | null = null;
    if (input.incidentId) {
      const [inc] = await tx.select().from(incidents).where(eq(incidents.id, input.incidentId));
      if (!inc || inc.employeeId !== input.employeeId) throw new DomainError('INCIDENT_NOT_FOUND');
      incidentId = inc.id;
    }
    const correction = await this.insertCorrection(tx, ctx, session!, 'CREATE_SESSION', { incidentId, requestId: extra.requestId, original: null, corrected: { startedAt: start, endedAt: end, shiftId }, before: null, after, reason });
    const resolved = { resolution: 'CORRECTED' as const, reason, at: now, correctionId: correction.id };
    if (shiftId) {
      await resolveIncidents(tx, ctx, { shiftId, types: ['FALTA'] }, resolved);
    } else {
      // D-72: una jornada que realmente ocurrió sin turno se marca igual que en el kiosco (D-6, D-17)
      const base = { branchId: input.branchId, employeeId: input.employeeId, operationalDate: opDate, workSessionId: session!.id };
      await openIncident(tx, ctx, { ...base, type: 'SIN_TURNO_PROGRAMADO' }, 'CORRECTION', now);
      if (!(await isAssignedOn(tx, input.employeeId, input.branchId, opDate))) {
        await openIncident(tx, ctx, { ...base, type: 'SIN_ASIGNACION_SUCURSAL' }, 'CORRECTION', now);
      }
    }
    await this.recompute(tx, ctx, session!.id, now, correction.id, reason);
    await this.audit.record(tx, ctx, {
      action: 'attendance.session_created_by_correction',
      entityType: 'work_session',
      entityId: session!.id,
      branchId: input.branchId,
      after: { ...after, correctionId: correction.id, requestId: extra.requestId ?? null },
      reason,
    });
    return { correctionId: correction.id, session: { ...after, id: session!.id, version: session!.version } };
  }

  /** Resolver una incidencia sin corrección de horas (justificar, confirmar o descartar), con motivo. */
  async resolveIncident(ctx: TenantContext, access: AccessProfile, incidentId: string, expectedVersion: number, resolution: 'JUSTIFIED' | 'CONFIRMED' | 'DISMISSED', reasonInput: string) {
    const reason = this.requireReason(reasonInput);
    return this.tenantDb.run(ctx, async (tx) => {
      const [inc] = await tx.select().from(incidents).where(eq(incidents.id, incidentId)).for('update');
      if (!inc) throw new DomainError('INCIDENT_NOT_FOUND');
      this.authorize(access, 'incidents.resolve', inc.branchId, inc.employeeId, 'INCIDENT_NOT_FOUND');
      if (inc.version !== expectedVersion) throw new DomainError('INCIDENT_VERSION_CONFLICT', { currentVersion: inc.version });
      if (inc.status !== 'OPEN') throw new DomainError('INCIDENT_ALREADY_RESOLVED');
      const now = this.clock();
      const [after] = await tx
        .update(incidents)
        .set({ status: 'RESOLVED', resolution, resolutionSource: 'USER', resolvedAt: now, resolvedBy: ctx.actor.userId ?? null, resolutionReason: reason, version: sql`${incidents.version} + 1` })
        .where(and(eq(incidents.id, inc.id), eq(incidents.version, expectedVersion)))
        .returning();
      await this.audit.record(tx, ctx, {
        action: 'attendance.incident_resolved',
        entityType: inc.workSessionId ? 'work_session' : 'incident',
        entityId: inc.workSessionId ?? inc.id,
        branchId: inc.branchId,
        before: { incidentId: inc.id, type: inc.type, status: 'OPEN' },
        after: { incidentId: inc.id, type: inc.type, status: 'RESOLVED', resolution },
        reason,
      });
      return after!;
    });
  }
}

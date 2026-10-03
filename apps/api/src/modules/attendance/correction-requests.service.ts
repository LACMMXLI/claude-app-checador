import { and, asc, count, desc, eq, gte, inArray, lte, or } from 'drizzle-orm';
import { DomainError, isPgError, raisedCode } from '../../common/errors.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';
import { addDaysToDate, localToUtc } from '../../common/zoned-time.js';
import { attendanceEvents, branches, correctionRequests, employees, incidents, users, workSessions } from '../../db/schema/index.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AccessProfile } from '../auth/rbac.service.js';
import type { PoliciesService } from '../policies/policies.service.js';
import { breaksOf, loadBranch, loadShift, sessionView, shiftSummary } from './attendance-common.js';
import { operationalDateIn } from '../../common/operational-day.js';
import type { CorrectionInput, CorrectionsService, LocalInstant } from './corrections.service.js';

export type RequestAction = 'SET_CLOCK_IN' | 'SET_CLOCK_OUT' | 'SET_BREAK_START' | 'SET_BREAK_END' | 'ADD_BREAK' | 'CREATE_SESSION';
export const REQUEST_ACTIONS: readonly RequestAction[] = ['SET_CLOCK_IN', 'SET_CLOCK_OUT', 'SET_BREAK_START', 'SET_BREAK_END', 'ADD_BREAK', 'CREATE_SESSION'];

export interface NewRequestInput {
  clientRequestId: string;
  action: RequestAction;
  workSessionId?: string | null;
  breakId?: string | null;
  shiftId?: string | null;
  /** Solo para CREATE_SESSION sin turno: sucursal donde ocurrió. */
  branchId?: string | null;
  start: LocalInstant;
  end?: LocalInstant | null;
  reason: string;
}

/** Quién solicita: el empleado identificado por PIN en un kiosco, o un miembro con ficha desde el panel. */
export type Requester = { channel: 'KIOSK'; deviceId: string } | { channel: 'PANEL'; userId: string };

type RequestRow = typeof correctionRequests.$inferSelect;

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Solicitudes de corrección (D-70, D-71). El empleado SOLICITA (nunca modifica); otra persona con permiso en la sucursal
 * donde ocurrió APRUEBA exactamente lo solicitado (la corrección se ejecuta con el MISMO código de la corrección directa,
 * en la misma transacción) o RECHAZA con motivo. Unicidad de pendientes, transiciones y "nadie decide la suya" también
 * los impone PostgreSQL.
 */
export class CorrectionRequestsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly policies: PoliciesService,
    private readonly corrections: CorrectionsService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  view(r: RequestRow) {
    return {
      id: r.id,
      branchId: r.branchId,
      employeeId: r.employeeId,
      operationalDate: r.operationalDate,
      action: r.action as RequestAction,
      workSessionId: r.workSessionId,
      breakId: r.breakId,
      shiftId: r.shiftId,
      proposedStart: r.proposedStart,
      proposedEnd: r.proposedEnd,
      proposedLocal: r.proposedLocal,
      reason: r.reason,
      channel: r.channel,
      status: r.status,
      decidedAt: r.decidedAt,
      decisionReason: r.decisionReason,
      correctionId: r.correctionId,
      version: r.version,
      createdAt: r.createdAt,
    };
  }

  // ── crear ──────────────────────────────────────────────────────────────────
  /** Crea una solicitud de la PROPIA ficha (`employeeId` viene del PIN o de la membresía, nunca del cliente). Idempotente. */
  async create(ctx: TenantContext, requester: Requester, employeeId: string, input: NewRequestInput) {
    const reason = input.reason?.trim();
    if (!reason) throw new DomainError('REASON_REQUIRED');
    if (reason.length > 500) throw new DomainError('VALIDATION_ERROR', { fields: ['reason'] });
    try {
      return await this.tenantDb.run(ctx, async (tx) => {
        const replay = await this.findByClientId(tx, requester, input.clientRequestId);
        if (replay) {
          if (replay.employeeId !== employeeId || replay.action !== input.action) throw new DomainError('IDEMPOTENCY_KEY_REUSED');
          return { request: this.view(replay), replayed: true };
        }
        // serializa las solicitudes del mismo empleado (conteo de pendientes)
        const [emp] = await tx.select({ id: employees.id, status: employees.status }).from(employees).where(eq(employees.id, employeeId)).for('update');
        if (!emp || emp.status !== 'ACTIVE') throw new DomainError('EMPLOYEE_INACTIVE');
        const now = this.clock();
        const target = await this.resolveTarget(tx, employeeId, input);
        const branch = await loadBranch(tx, target.branchId);
        const toUtc = (l: LocalInstant) => localToUtc(l.date, l.time, branch.timezone, l.fold);
        const start = toUtc(input.start);
        const end = input.end ? toUtc(input.end) : null;
        if (start.getTime() > now.getTime() || (end && end.getTime() > now.getTime())) throw new DomainError('CORRECTION_IN_FUTURE');
        if (end && end.getTime() <= start.getTime()) throw new DomainError('CORRECTION_ORDER_INVALID', { field: 'end' });
        const { policy } = await this.policies.getEffectiveTx(tx, ctx, { branchId: target.branchId, employeeId });
        const calendar = await this.policies.calendarTx(tx, ctx, target.branchId);
        // D-78: el día operativo del objetivo (jornada o turno) o, sin objetivo, el de la hora de inicio propuesta
        const opDate = target.operationalDate ?? operationalDateIn(start, calendar);
        // Precisión A: la ventana se mide en DÍAS OPERATIVOS de la sucursal, no en horas desde created_at
        const today = operationalDateIn(now, calendar);
        const age = daysBetween(opDate, today);
        if (age < 0 || age > policy.correctionRequestWindowDays) {
          throw new DomainError('REQUEST_OUTSIDE_WINDOW', { windowDays: policy.correctionRequestWindowDays, operationalDate: opDate });
        }
        const [{ value: pending }] = (await tx
          .select({ value: count() })
          .from(correctionRequests)
          .where(and(eq(correctionRequests.employeeId, employeeId), eq(correctionRequests.status, 'PENDING')))) as [{ value: number }];
        if (pending >= policy.maxPendingCorrectionRequests) throw new DomainError('TOO_MANY_PENDING_REQUESTS', { max: policy.maxPendingCorrectionRequests });

        const [row] = await tx
          .insert(correctionRequests)
          .values({
            organizationId: ctx.organizationId,
            branchId: target.branchId,
            employeeId,
            operationalDate: opDate,
            action: input.action,
            workSessionId: target.workSessionId,
            breakId: target.breakId,
            shiftId: target.shiftId,
            incidentId: target.incidentId,
            proposedStart: start,
            proposedEnd: end,
            proposedLocal: { start: input.start, end: input.end ?? null, timezone: branch.timezone },
            reason,
            channel: requester.channel,
            requestedByUserId: requester.channel === 'PANEL' ? requester.userId : null,
            requestedDeviceId: requester.channel === 'KIOSK' ? requester.deviceId : null,
            clientRequestId: input.clientRequestId,
            sessionVersionAtRequest: target.sessionVersion,
          })
          .returning();
        await this.audit.record(tx, ctx, {
          action: 'correction_request.created',
          entityType: 'correction_request',
          entityId: row!.id,
          branchId: target.branchId,
          after: { ...this.view(row!), reason: undefined },
          reason,
        });
        return { request: this.view(row!), replayed: false };
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (isPgError(error, '23505', 'requests_idempotency_device') || isPgError(error, '23505', 'requests_idempotency_user')) {
        const replayed = await this.tenantDb.run(ctx, (tx) => this.findByClientId(tx, requester, input.clientRequestId));
        if (replayed) return { request: this.view(replayed), replayed: true };
      }
      if (isPgError(error, '23505')) throw new DomainError('REQUEST_ALREADY_PENDING');
      const raised = raisedCode(error);
      if (raised) throw new DomainError(raised);
      throw error;
    }
  }

  private async findByClientId(tx: Tx, requester: Requester, clientRequestId: string) {
    const [row] = await tx
      .select()
      .from(correctionRequests)
      .where(
        and(
          eq(correctionRequests.clientRequestId, clientRequestId),
          requester.channel === 'KIOSK' ? eq(correctionRequests.requestedDeviceId, requester.deviceId) : eq(correctionRequests.requestedByUserId, requester.userId),
        ),
      );
    return row ?? null;
  }

  /** Valida que el objetivo sea del propio empleado y deduce sucursal y día operativo. */
  private async resolveTarget(tx: Tx, employeeId: string, input: NewRequestInput) {
    const empty = { workSessionId: null as string | null, breakId: null as string | null, shiftId: null as string | null, incidentId: null as string | null, sessionVersion: null as number | null };
    if (input.action === 'CREATE_SESSION') {
      if (!input.end) throw new DomainError('VALIDATION_ERROR', { fields: ['end'] });
      if (input.shiftId) {
        const shift = await loadShift(tx, input.shiftId);
        if (!shift || shift.employeeId !== employeeId) throw new DomainError('SHIFT_NOT_FOUND');
        if (shift.status !== 'SCHEDULED' || shift.scheduleStatus !== 'PUBLISHED') throw new DomainError('SHIFT_NOT_OFFICIAL');
        const [linked] = await tx.select({ id: workSessions.id }).from(workSessions).where(eq(workSessions.shiftId, shift.id));
        if (linked) throw new DomainError('SHIFT_ALREADY_HAS_SESSION');
        const [falta] = await tx
          .select({ id: incidents.id })
          .from(incidents)
          .where(and(eq(incidents.shiftId, shift.id), eq(incidents.type, 'FALTA'), eq(incidents.status, 'OPEN')));
        return { ...empty, branchId: shift.branchId, shiftId: shift.id, incidentId: falta?.id ?? null, operationalDate: shift.operationalDate };
      }
      if (!input.branchId) throw new DomainError('VALIDATION_ERROR', { fields: ['branchId'] });
      const branch = await loadBranch(tx, input.branchId);
      if (!branch.isActive) throw new DomainError('BRANCH_INACTIVE');
      return { ...empty, branchId: branch.id, operationalDate: null as string | null };
    }
    if (!input.workSessionId) throw new DomainError('VALIDATION_ERROR', { fields: ['workSessionId'] });
    const [s] = await tx.select().from(workSessions).where(eq(workSessions.id, input.workSessionId));
    if (!s || s.employeeId !== employeeId) throw new DomainError('SESSION_NOT_FOUND'); // nunca la jornada de otra persona
    if ((input.action === 'SET_BREAK_START' || input.action === 'SET_BREAK_END') !== Boolean(input.breakId)) {
      throw new DomainError('VALIDATION_ERROR', { fields: ['breakId'] });
    }
    if (input.breakId) {
      const list = await breaksOf(tx, [s.id]);
      if (!list.some((b) => b.id === input.breakId)) throw new DomainError('BREAK_NOT_FOUND');
    }
    if ((input.action === 'ADD_BREAK') !== Boolean(input.end)) throw new DomainError('VALIDATION_ERROR', { fields: ['end'] });
    return { ...empty, branchId: s.branchId, workSessionId: s.id, breakId: input.breakId ?? null, operationalDate: s.operationalDate, sessionVersion: s.version };
  }

  // ── cancelar (solo el solicitante) ───────────────────────────────────────────
  async cancel(ctx: TenantContext, requester: Requester, employeeId: string, requestId: string) {
    return this.tenantDb.run(ctx, async (tx) => {
      const [r] = await tx.select().from(correctionRequests).where(eq(correctionRequests.id, requestId)).for('update');
      if (!r || r.employeeId !== employeeId) throw new DomainError('REQUEST_NOT_FOUND');
      if (r.status !== 'PENDING') throw new DomainError('REQUEST_ALREADY_DECIDED');
      const [after] = await tx
        .update(correctionRequests)
        .set({ status: 'CANCELLED', decidedAt: this.clock(), decidedBy: requester.channel === 'PANEL' ? requester.userId : null, version: r.version + 1 })
        .where(eq(correctionRequests.id, r.id))
        .returning();
      await this.audit.record(tx, ctx, { action: 'correction_request.cancelled', entityType: 'correction_request', entityId: r.id, branchId: r.branchId, before: { status: 'PENDING' }, after: { status: 'CANCELLED' } });
      return this.view(after!);
    });
  }

  // ── decidir ─────────────────────────────────────────────────────────────────
  private assertCanDecide(ctx: TenantContext, access: AccessProfile, r: RequestRow) {
    if (!access.can('attendance.view', r.branchId) && !access.can('attendance.correction.apply', r.branchId)) throw new DomainError('REQUEST_NOT_FOUND');
    if (!access.can('attendance.correction.apply', r.branchId)) throw new DomainError('FORBIDDEN', { permission: 'attendance.correction.apply' });
    if ((access.employeeId && access.employeeId === r.employeeId) || (ctx.actor.userId && ctx.actor.userId === r.requestedByUserId)) {
      throw new DomainError('SELF_APPROVAL_FORBIDDEN');
    }
  }

  /**
   * Aprueba EXACTAMENTE lo solicitado (decisión 2: sin ajustes). Si la jornada cambió desde que se revisó
   * (`expectedSessionVersion`) o la corrección ya no es válida, NADA cambia y la solicitud sigue PENDIENTE.
   */
  async approve(ctx: TenantContext, access: AccessProfile, requestId: string, expectedVersion: number, expectedSessionVersion: number | null) {
    try {
      return await this.tenantDb.run(ctx, async (tx) => {
        const [r] = await tx.select().from(correctionRequests).where(eq(correctionRequests.id, requestId)).for('update');
        if (!r) throw new DomainError('REQUEST_NOT_FOUND');
        this.assertCanDecide(ctx, access, r);
        if (r.version !== expectedVersion) throw new DomainError('REQUEST_VERSION_CONFLICT', { currentVersion: r.version });
        if (r.status !== 'PENDING') throw new DomainError('REQUEST_ALREADY_DECIDED');
        const at = (d: Date) => ({ instant: d });
        let result: { correctionId: string; session: { id: string } };
        if (r.action === 'CREATE_SESSION') {
          result = await this.corrections.createSessionTx(
            tx,
            ctx,
            access,
            { employeeId: r.employeeId, branchId: r.branchId, shiftId: r.shiftId, incidentId: r.incidentId, start: at(r.proposedStart), end: at(r.proposedEnd!) },
            r.reason,
            { requestId: r.id },
          );
        } else {
          if (expectedSessionVersion === null) throw new DomainError('VALIDATION_ERROR', { fields: ['expectedSessionVersion'] });
          const input: CorrectionInput =
            r.action === 'ADD_BREAK'
              ? { action: 'ADD_BREAK', start: at(r.proposedStart), end: at(r.proposedEnd!) }
              : r.action === 'SET_BREAK_START' || r.action === 'SET_BREAK_END'
                ? { action: r.action, breakId: r.breakId!, at: at(r.proposedStart) }
                : { action: r.action as 'SET_CLOCK_IN' | 'SET_CLOCK_OUT', at: at(r.proposedStart) };
          result = await this.corrections.applyTx(tx, ctx, access, r.workSessionId!, expectedSessionVersion, input, r.reason, { requestId: r.id, notFound: 'REQUEST_NOT_FOUND' });
        }
        const [after] = await tx
          .update(correctionRequests)
          .set({ status: 'APPROVED', decidedBy: ctx.actor.userId!, decidedAt: this.clock(), correctionId: result.correctionId, version: r.version + 1 })
          .where(eq(correctionRequests.id, r.id))
          .returning();
        await this.audit.record(tx, ctx, {
          action: 'correction_request.approved',
          entityType: 'correction_request',
          entityId: r.id,
          branchId: r.branchId,
          before: { status: 'PENDING' },
          after: { status: 'APPROVED', correctionId: result.correctionId, workSessionId: result.session.id },
        });
        return { request: this.view(after!), correctionId: result.correctionId, workSessionId: result.session.id };
      });
    } catch (error) {
      return this.corrections.mapDbError(error);
    }
  }

  async reject(ctx: TenantContext, access: AccessProfile, requestId: string, expectedVersion: number, reasonInput: string) {
    const reason = reasonInput?.trim();
    if (!reason) throw new DomainError('REASON_REQUIRED');
    try {
      return await this.tenantDb.run(ctx, async (tx) => {
        const [r] = await tx.select().from(correctionRequests).where(eq(correctionRequests.id, requestId)).for('update');
        if (!r) throw new DomainError('REQUEST_NOT_FOUND');
        this.assertCanDecide(ctx, access, r);
        if (r.version !== expectedVersion) throw new DomainError('REQUEST_VERSION_CONFLICT', { currentVersion: r.version });
        if (r.status !== 'PENDING') throw new DomainError('REQUEST_ALREADY_DECIDED');
        const [after] = await tx
          .update(correctionRequests)
          .set({ status: 'REJECTED', decidedBy: ctx.actor.userId!, decidedAt: this.clock(), decisionReason: reason, version: r.version + 1 })
          .where(eq(correctionRequests.id, r.id))
          .returning();
        await this.audit.record(tx, ctx, { action: 'correction_request.rejected', entityType: 'correction_request', entityId: r.id, branchId: r.branchId, before: { status: 'PENDING' }, after: { status: 'REJECTED' }, reason });
        return this.view(after!);
      });
    } catch (error) {
      return this.corrections.mapDbError(error);
    }
  }

  // ── consultas ───────────────────────────────────────────────────────────────
  /** Bandeja: solicitudes de las sucursales donde el usuario puede ver asistencia. */
  async list(ctx: TenantContext, access: AccessProfile, filter: { status?: string; branchId?: string; employeeId?: string; from?: string; to?: string }) {
    const scope = access.branchesFor('attendance.view');
    if (filter.branchId && !access.can('attendance.view', filter.branchId)) throw new DomainError('BRANCH_NOT_FOUND');
    if (scope !== 'ALL' && scope.size === 0) throw new DomainError('FORBIDDEN', { permission: 'attendance.view' });
    return this.tenantDb.run(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(correctionRequests)
        .where(
          and(
            filter.branchId ? eq(correctionRequests.branchId, filter.branchId) : scope === 'ALL' ? undefined : inArray(correctionRequests.branchId, [...scope]),
            filter.status ? eq(correctionRequests.status, filter.status) : undefined,
            filter.employeeId ? eq(correctionRequests.employeeId, filter.employeeId) : undefined,
            filter.from ? gte(correctionRequests.operationalDate, filter.from) : undefined,
            filter.to ? lte(correctionRequests.operationalDate, filter.to) : undefined,
          ),
        )
        .orderBy(desc(correctionRequests.createdAt))
        .limit(500);
      return this.decorate(tx, ctx, access, rows);
    });
  }

  async pendingCount(ctx: TenantContext, access: AccessProfile) {
    const scope = access.branchesFor('attendance.correction.apply');
    if (scope !== 'ALL' && scope.size === 0) return { pending: 0 };
    return this.tenantDb.run(ctx, async (tx) => {
      const rows = await tx
        .select({ branchId: correctionRequests.branchId, employeeId: correctionRequests.employeeId })
        .from(correctionRequests)
        .where(and(eq(correctionRequests.status, 'PENDING'), scope === 'ALL' ? undefined : inArray(correctionRequests.branchId, [...scope])));
      return { pending: rows.filter((r) => r.employeeId !== access.employeeId).length };
    });
  }

  private async decorate(tx: Tx, ctx: TenantContext, access: AccessProfile, rows: RequestRow[]) {
    const ids = [...new Set(rows.map((r) => r.employeeId))];
    const people = ids.length
      ? new Map((await tx.select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName, employeeNumber: employees.employeeNumber }).from(employees).where(inArray(employees.id, ids))).map((p) => [p.id, p]))
      : new Map();
    const branchNames = new Map((await tx.select({ id: branches.id, name: branches.name }).from(branches)).map((b) => [b.id, b.name]));
    const deciders = [...new Set(rows.map((r) => r.decidedBy).filter((x): x is string => Boolean(x)))];
    const names = deciders.length ? new Map((await tx.select({ id: users.id, n: users.displayName }).from(users).where(inArray(users.id, deciders))).map((u) => [u.id, u.n])) : new Map();
    return rows.map((r) => {
      let canDecide = r.status === 'PENDING';
      try {
        this.assertCanDecide(ctx, access, r);
      } catch {
        canDecide = false;
      }
      return {
        ...this.view(r),
        employee: { id: r.employeeId, ...people.get(r.employeeId) },
        branchName: branchNames.get(r.branchId) ?? null,
        decidedBy: r.decidedBy ? { id: r.decidedBy, displayName: names.get(r.decidedBy) ?? null } : null,
        canDecide,
      };
    });
  }

  /** Detalle para decidir: lo solicitado, el estado EFECTIVO actual de la jornada y lo registrado físicamente. */
  async get(ctx: TenantContext, access: AccessProfile, requestId: string) {
    return this.tenantDb.run(ctx, async (tx) => {
      const [r] = await tx.select().from(correctionRequests).where(eq(correctionRequests.id, requestId));
      if (!r || !access.can('attendance.view', r.branchId)) throw new DomainError('REQUEST_NOT_FOUND');
      const [decorated] = await this.decorate(tx, ctx, access, [r]);
      const branch = await loadBranch(tx, r.branchId);
      let session = null;
      let recorded: { type: string; occurredAt: Date }[] = [];
      if (r.workSessionId) {
        const [s] = await tx.select().from(workSessions).where(eq(workSessions.id, r.workSessionId));
        const shift = await loadShift(tx, s!.shiftId);
        session = { ...sessionView(s!, await breaksOf(tx, [s!.id]), shift, this.clock()), shift: shiftSummary(shift) };
        recorded = await tx.select({ type: attendanceEvents.type, occurredAt: attendanceEvents.occurredAt }).from(attendanceEvents).where(eq(attendanceEvents.workSessionId, s!.id)).orderBy(asc(attendanceEvents.occurredAt));
      }
      const shift = r.shiftId ? shiftSummary(await loadShift(tx, r.shiftId)) : null;
      return { ...decorated!, timezone: branch.timezone, session, recorded, shift };
    });
  }

  // ── autoservicio del empleado ───────────────────────────────────────────────
  /**
   * "Mis registros" (kiosco) / "Mis jornadas" (panel): SOLO la propia ficha y SOLO la ventana de solicitud, con datos
   * mínimos (D-59): jornadas, pausas, faltas de sus turnos y sus solicitudes recientes.
   */
  async ownRecords(ctx: TenantContext, employeeId: string, referenceBranchId: string) {
    const now = this.clock();
    return this.tenantDb.run(ctx, async (tx) => {
      const { policy } = await this.policies.getEffectiveTx(tx, ctx, { branchId: referenceBranchId, employeeId });
      const to = operationalDateIn(now, await this.policies.calendarTx(tx, ctx, referenceBranchId));
      const from = addDaysToDate(to, -policy.correctionRequestWindowDays);
      const sessions = await tx
        .select()
        .from(workSessions)
        .where(and(eq(workSessions.employeeId, employeeId), gte(workSessions.operationalDate, from), lte(workSessions.operationalDate, to)))
        .orderBy(desc(workSessions.startedAt));
      const allBreaks = await breaksOf(tx, sessions.map((s) => s.id));
      const branchRows = await tx.select({ id: branches.id, name: branches.name }).from(branches);
      const tzOf = async (id: string) => (await loadBranch(tx, id)).timezone;
      const faltas = await tx
        .select()
        .from(incidents)
        .where(and(eq(incidents.employeeId, employeeId), eq(incidents.type, 'FALTA'), eq(incidents.status, 'OPEN'), gte(incidents.operationalDate, from), lte(incidents.operationalDate, to)));
      const requests = await tx
        .select()
        .from(correctionRequests)
        .where(and(eq(correctionRequests.employeeId, employeeId), or(eq(correctionRequests.status, 'PENDING'), gte(correctionRequests.operationalDate, from))))
        .orderBy(desc(correctionRequests.createdAt))
        .limit(20);
      const name = (id: string) => branchRows.find((b) => b.id === id)?.name ?? null;
      return {
        window: { from, to, days: policy.correctionRequestWindowDays },
        sessions: await Promise.all(
          sessions.map(async (s) => {
            const shift = await loadShift(tx, s.shiftId);
            return {
              id: s.id,
              operationalDate: s.operationalDate,
              branchId: s.branchId,
              branchName: name(s.branchId),
              timezone: await tzOf(s.branchId),
              startedAt: s.startedAt,
              endedAt: s.endedAt,
              status: s.status,
              shift: shift ? { startTime: shiftSummary(shift)!.startTime, endTime: shiftSummary(shift)!.endTime, crossesMidnight: shiftSummary(shift)!.crossesMidnight } : null,
              breaks: allBreaks.filter((b) => b.workSessionId === s.id).map((b) => ({ id: b.id, sequence: b.sequence, startedAt: b.startedAt, endedAt: b.endedAt })),
            };
          }),
        ),
        absences: await Promise.all(
          faltas.map(async (f) => {
            const shift = shiftSummary(await loadShift(tx, f.shiftId));
            return { shiftId: f.shiftId, operationalDate: f.operationalDate, branchId: f.branchId, branchName: name(f.branchId), timezone: await tzOf(f.branchId), startTime: shift?.startTime ?? null, endTime: shift?.endTime ?? null, crossesMidnight: shift?.crossesMidnight ?? false };
          }),
        ),
        requests: requests.map((r) => ({ id: r.id, action: r.action, status: r.status, operationalDate: r.operationalDate, workSessionId: r.workSessionId, shiftId: r.shiftId, proposedLocal: r.proposedLocal, decisionReason: r.decisionReason, createdAt: r.createdAt })),
      };
    });
  }
}

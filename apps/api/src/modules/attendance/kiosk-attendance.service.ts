import { and, desc, eq, sql } from 'drizzle-orm';
import { DomainError, isPgError, raisedCode } from '../../common/errors.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';
import { attendanceEvents, branches, breaks, employees, workSessions } from '../../db/schema/index.js';
import type { AuditService } from '../audit/audit.service.js';
import type { KioskIdentificationService } from '../auth/pin-attempts.service.js';
import type { EffectivePolicy } from '../policies/policy.js';
import type { PoliciesService } from '../policies/policies.service.js';
import {
  type PunchAction,
  type SessionRow,
  type ShiftRow,
  breaksOf,
  endedShiftsWithoutSession,
  isAssignedOn,
  loadBranch,
  loadShift,
  nextOfficialShift,
  openIncident,
  shiftSummary,
  shiftsInWindow,
  snapshotOf,
} from './attendance-common.js';
import { isLate, minutesBetween } from './attendance-time.js';
import { operationalDateIn } from '../../common/operational-day.js';
import type { KioskTickets } from './kiosk-ticket.js';
import type { ReconcilerService } from './reconciler.service.js';
import type { CorrectionRequestsService, NewRequestInput } from './correction-requests.service.js';
import { syncDerivedIncidents } from './session-rules.js';

export interface KioskDevice {
  deviceId: string;
  branchId: string;
}

/** Resultado de una checada (o de su reintento idempotente: `replayed = true`). */
export interface PunchResult {
  action: PunchAction;
  occurredAt: Date;
  replayed: boolean;
  workSessionId: string;
  arrivalDeltaMinutes?: number | null;
  shift?: ReturnType<typeof shiftSummary>;
  flags?: string[];
  break?: { sequence: number; allowedMinutes: number; durationMinutes?: number | null; exceededMinutes?: number | null };
  elapsedMinutes?: number;
  departureDeltaMinutes?: number | null;
}

export interface PunchInput {
  ticket: string;
  action: PunchAction;
  clientEventId: string;
}

/**
 * Asistencia desde el kiosco (D-34 … D-50, D-54, D-55). El negocio, la sucursal y el dispositivo salen del
 * token del kiosco; el empleado, del pase firmado que se obtuvo con su PIN. El servidor decide la hora.
 *
 * Concurrencia: cada checada bloquea la fila del empleado (serializa sus peticiones) y además PostgreSQL
 * garantiza una jornada abierta por empleado, una pausa abierta por jornada y la idempotencia por
 * `(device_id, client_event_id)`.
 */
export class KioskAttendanceService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly policies: PoliciesService,
    private readonly identification: KioskIdentificationService,
    private readonly reconciler: ReconcilerService,
    private readonly tickets: KioskTickets,
    private readonly requests: CorrectionRequestsService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Empleado del pase (solo para ESTE negocio y ESTE dispositivo) + un pase renovado mientras la pantalla siga en uso. */
  private employeeFromTicket(ctx: TenantContext, device: KioskDevice, ticket: string) {
    const deviceId = ctx.actor.deviceId;
    if (ctx.actor.type !== 'KIOSK' || !deviceId || deviceId !== device.deviceId) throw new DomainError('KIOSK_CONTEXT_REQUIRED');
    const now = this.clock();
    const employeeId = this.tickets.verify(ticket, { organizationId: ctx.organizationId, deviceId }, now);
    const renewed = this.tickets.issue({ organizationId: ctx.organizationId, deviceId, employeeId }, now);
    return { employeeId, renewed };
  }

  /** "Mis registros" (D-70, precisión G): solo la propia ficha, solo la ventana de solicitud, datos mínimos. */
  async myRecords(ctx: TenantContext, device: KioskDevice, ticket: string) {
    const { employeeId, renewed } = this.employeeFromTicket(ctx, device, ticket);
    return { ticket: renewed.ticket, ticketExpiresAt: renewed.expiresAt, ...(await this.requests.ownRecords(ctx, employeeId, device.branchId)) };
  }

  async requestCorrection(ctx: TenantContext, device: KioskDevice, ticket: string, input: NewRequestInput) {
    const { employeeId, renewed } = this.employeeFromTicket(ctx, device, ticket);
    const result = await this.requests.create(ctx, { channel: 'KIOSK', deviceId: device.deviceId }, employeeId, input);
    return { ticket: renewed.ticket, ...result };
  }

  async cancelRequest(ctx: TenantContext, device: KioskDevice, ticket: string, requestId: string) {
    const { employeeId, renewed } = this.employeeFromTicket(ctx, device, ticket);
    const request = await this.requests.cancel(ctx, { channel: 'KIOSK', deviceId: device.deviceId }, employeeId, requestId);
    return { ticket: renewed.ticket, request };
  }

  private policy(tx: Tx, ctx: TenantContext, branchId: string, employeeId: string): Promise<EffectivePolicy> {
    return this.policies.getEffectiveTx(tx, ctx, { branchId, employeeId }).then((r) => r.policy);
  }

  private async openSession(tx: Tx, employeeId: string, lock = false): Promise<SessionRow | null> {
    const q = tx.select().from(workSessions).where(and(eq(workSessions.employeeId, employeeId), eq(workSessions.status, 'OPEN')));
    const [row] = lock ? await q.for('update') : await q;
    return row ?? null;
  }

  /** D-39: acciones POSIBLES según la jornada actual (nunca se muestran acciones imposibles). */
  private async stateTx(tx: Tx, ctx: TenantContext, device: KioskDevice, employeeId: string, now: Date) {
    const policy = await this.policy(tx, ctx, device.branchId, employeeId);
    const session = await this.openSession(tx, employeeId);
    const branchName = async (id: string) => (await tx.select({ name: branches.name }).from(branches).where(eq(branches.id, id)))[0]?.name ?? null;

    if (!session) {
      const [candidate] = await shiftsInWindow(tx, employeeId, { id: device.branchId }, now, policy.earlyEntryWindowMin);
      const shift = candidate ?? (await nextOfficialShift(tx, employeeId, device.branchId, now));
      return { status: 'NONE' as const, actions: ['CLOCK_IN'] as PunchAction[], session: null, shift: shiftSummary(shift, shift ? (await branchName(shift.branchId)) ?? undefined : undefined), openBreak: null };
    }
    const list = await breaksOf(tx, [session.id]);
    const open = list.find((b) => b.endedAt === null) ?? null;
    const shift = await loadShift(tx, session.shiftId);
    const actions: PunchAction[] = open ? ['BREAK_END'] : [...(list.length < policy.maxBreaks ? (['BREAK_START'] as const) : []), 'CLOCK_OUT'];
    return {
      status: open ? ('ON_BREAK' as const) : ('WORKING' as const),
      actions,
      session: {
        startedAt: session.startedAt,
        branchId: session.branchId,
        branchName: session.branchId === device.branchId ? null : await branchName(session.branchId),
        breaksTaken: list.length,
        maxBreaks: policy.maxBreaks,
      },
      shift: shiftSummary(shift, shift ? ((await branchName(shift.branchId)) ?? undefined) : undefined),
      openBreak: open ? { startedAt: open.startedAt, allowedMinutes: open.allowedMinutes } : null,
    };
  }

  /**
   * PIN (con la protección D-21) ⇒ pase corto + lo que el empleado puede hacer ahora. Solo datos propios y
   * mínimos (D-59): nombre para mostrar, sucursal, turno actual/próximo oficial y acciones.
   */
  async identify(ctx: TenantContext, device: KioskDevice, pin: string) {
    const employee = await this.identification.identify(ctx, device.branchId, pin);
    const now = this.clock();
    return this.tenantDb.run(ctx, async (tx) => {
      // RN-OPE-05: si su jornada abierta ya venció, se manda a corrección antes de decidir las acciones
      const stale = await this.openSession(tx, employee.id);
      if (stale) await this.reconciler.reviewSessionTx(tx, ctx, stale, now);
      const state = await this.stateTx(tx, ctx, device, employee.id, now);
      const { ticket, expiresAt } = this.tickets.issue({ organizationId: ctx.organizationId, deviceId: device.deviceId, employeeId: employee.id }, now);
      return { ticket, ticketExpiresAt: expiresAt, serverTime: now, employee: { id: employee.id, displayName: employee.firstName }, ...state };
    });
  }

  /** Checada idempotente: un reintento con el mismo `clientEventId` devuelve el MISMO resultado (D-54). */
  async punch(ctx: TenantContext, device: KioskDevice, input: PunchInput): Promise<PunchResult> {
    const deviceId = ctx.actor.deviceId;
    if (ctx.actor.type !== 'KIOSK' || !deviceId || deviceId !== device.deviceId) throw new DomainError('KIOSK_CONTEXT_REQUIRED');
    const now = this.clock();
    const employeeId = this.tickets.verify(input.ticket, { organizationId: ctx.organizationId, deviceId }, now);
    try {
      return await this.tenantDb.run(ctx, async (tx) => {
        // Serializa TODAS las checadas de este empleado (doble toque, dos kioscos, reintentos simultáneos)
        const [employee] = await tx.select({ id: employees.id, status: employees.status, firstName: employees.firstName }).from(employees).where(eq(employees.id, employeeId)).for('update');
        if (!employee || employee.status !== 'ACTIVE') throw new DomainError('KIOSK_TICKET_INVALID');

        const replay = await this.replay(tx, deviceId, input, employeeId);
        if (replay) return replay;

        const policy = await this.policy(tx, ctx, device.branchId, employeeId);
        const [last] = await tx
          .select({ occurredAt: attendanceEvents.occurredAt })
          .from(attendanceEvents)
          .where(eq(attendanceEvents.employeeId, employeeId))
          .orderBy(desc(attendanceEvents.occurredAt))
          .limit(1);
        // RN-EVT-02: antirrebote configurable
        if (last && policy.debounceSec > 0 && now.getTime() - last.occurredAt.getTime() < policy.debounceSec * 1000) {
          throw new DomainError('PUNCH_TOO_SOON', { retryAfterSec: Math.ceil((last.occurredAt.getTime() + policy.debounceSec * 1000 - now.getTime()) / 1000) });
        }

        const stale = await this.openSession(tx, employeeId, true);
        if (stale) await this.reconciler.reviewSessionTx(tx, ctx, stale, now); // RN-OPE-05
        const session = stale && (await this.openSession(tx, employeeId, true));
        const base = { ctx, tx, device, deviceId, employeeId, now, policy, clientEventId: input.clientEventId };
        switch (input.action) {
          case 'CLOCK_IN':
            if (session) throw new DomainError('ALREADY_CLOCKED_IN');
            return this.clockIn(base);
          case 'BREAK_START':
            if (!session) throw new DomainError('NO_OPEN_SESSION');
            return this.breakStart(base, session);
          case 'BREAK_END':
            if (!session) throw new DomainError('NO_OPEN_SESSION');
            return this.breakEnd(base, session);
          case 'CLOCK_OUT':
            if (!session) throw new DomainError('NO_OPEN_SESSION');
            return this.clockOut(base, session);
          default:
            throw new DomainError('VALIDATION_ERROR');
        }
      });
    } catch (error) {
      if (isPgError(error, '23505', 'events_idempotency')) {
        // la misma checada llegó dos veces al mismo tiempo: la otra petición ya la guardó
        const replayed = await this.tenantDb.run(ctx, (tx) => this.replay(tx, deviceId, input, employeeId));
        if (replayed) return replayed;
      }
      if (isPgError(error, '23505', 'work_sessions_one_open')) throw new DomainError('ALREADY_CLOCKED_IN');
      if (isPgError(error, '23505', 'breaks_one_open')) throw new DomainError('BREAK_ALREADY_OPEN');
      const raised = raisedCode(error);
      if (raised) throw new DomainError(raised);
      throw error;
    }
  }

  private async replay(tx: Tx, deviceId: string, input: PunchInput, employeeId: string): Promise<PunchResult | null> {
    const [event] = await tx
      .select()
      .from(attendanceEvents)
      .where(and(eq(attendanceEvents.deviceId, deviceId), eq(attendanceEvents.clientEventId, input.clientEventId)));
    if (!event) return null;
    if (event.employeeId !== employeeId || event.type !== input.action) throw new DomainError('IDEMPOTENCY_KEY_REUSED');
    return { action: event.type as PunchAction, occurredAt: event.occurredAt, replayed: true, workSessionId: event.workSessionId };
  }

  /** Toda checada cambia la jornada: sube su versión (las correcciones del panel usan concurrencia optimista). */
  private async bumpSession(tx: Tx, sessionId: string) {
    await tx.update(workSessions).set({ version: sql`${workSessions.version} + 1` }).where(eq(workSessions.id, sessionId));
  }

  private async recordEvent(
    b: { ctx: TenantContext; tx: Tx; device: KioskDevice; deviceId: string; employeeId: string; now: Date; clientEventId: string },
    type: PunchAction,
    workSessionId: string,
    breakId: string | null = null,
  ) {
    const [event] = await b.tx
      .insert(attendanceEvents)
      .values({
        organizationId: b.ctx.organizationId,
        branchId: b.device.branchId,
        employeeId: b.employeeId,
        workSessionId,
        breakId,
        type,
        clientEventId: b.clientEventId,
        deviceId: b.deviceId,
        occurredAt: b.now,
        source: 'KIOSK_ONLINE',
        timeSource: 'SERVER',
      })
      .returning();
    return event!;
  }

  /**
   * Entrada (D-35/D-36/D-41/D-46): liga al turno OFICIAL de esta sucursal cuya ventana la contiene; si no hay,
   * jornada sin turno (D-6) con sus marcas. Nunca se liga a un turno de otra sucursal. Se guarda la hora real.
   */
  private async clockIn(b: { ctx: TenantContext; tx: Tx; device: KioskDevice; deviceId: string; employeeId: string; now: Date; policy: EffectivePolicy; clientEventId: string }) {
    const { tx, ctx, now, policy, device, employeeId } = b;
    const branch = await loadBranch(tx, device.branchId);
    if (!branch.isActive) throw new DomainError('BRANCH_INACTIVE');
    const [shift] = await shiftsInWindow(tx, employeeId, { id: device.branchId }, now, policy.earlyEntryWindowMin);
    // D-78: con turno, el día operativo del turno; sin turno, el de la Entrada (calendario de la sucursal)
    const opDate = shift ? shift.operationalDate : operationalDateIn(now, await this.policies.calendarTx(tx, ctx, device.branchId));
    const [session] = await tx
      .insert(workSessions)
      .values({
        organizationId: ctx.organizationId,
        branchId: device.branchId,
        employeeId,
        shiftId: shift?.id ?? null,
        operationalDate: opDate,
        startedAt: now,
        status: 'OPEN',
        origin: 'KIOSK',
        policySnapshot: snapshotOf(policy),
      })
      .returning();
    const event = await this.recordEvent(b, 'CLOCK_IN', session!.id);

    const flags: string[] = [];
    const base = { branchId: device.branchId, employeeId, operationalDate: opDate, workSessionId: session!.id, shiftId: shift?.id ?? null };
    let arrivalDeltaMinutes: number | null = null;
    if (shift) {
      arrivalDeltaMinutes = minutesBetween(shift.startsAt, now); // D-41: diferencia real completa, con signo
      if (isLate(arrivalDeltaMinutes, policy.entryToleranceMin)) {
        await openIncident(tx, ctx, { ...base, type: 'RETARDO', details: { lateMinutes: arrivalDeltaMinutes, toleranceMin: policy.entryToleranceMin } }, 'KIOSK', now);
        flags.push('RETARDO');
      }
    } else {
      await openIncident(tx, ctx, { ...base, type: 'SIN_TURNO_PROGRAMADO' }, 'KIOSK', now);
      flags.push('SIN_TURNO_PROGRAMADO');
      const [elsewhere] = await shiftsInWindow(tx, employeeId, { exceptId: device.branchId }, now, policy.earlyEntryWindowMin);
      if (elsewhere) {
        await openIncident(tx, ctx, { ...base, type: 'TURNO_EN_OTRA_SUCURSAL', details: { otherShiftId: elsewhere.id, otherBranchId: elsewhere.branchId, startsAt: elsewhere.startsAt, endsAt: elsewhere.endsAt } }, 'KIOSK', now);
        flags.push('TURNO_EN_OTRA_SUCURSAL');
      }
      const [ended] = await endedShiftsWithoutSession(tx, employeeId, device.branchId, opDate, now);
      if (ended) {
        await openIncident(tx, ctx, { ...base, type: 'ENTRADA_FALTANTE', details: { endedShiftId: ended.id, startsAt: ended.startsAt, endsAt: ended.endsAt } }, 'KIOSK', now);
        flags.push('ENTRADA_FALTANTE');
      }
    }
    if (!(await isAssignedOn(tx, employeeId, device.branchId, opDate))) {
      await openIncident(tx, ctx, { ...base, type: 'SIN_ASIGNACION_SUCURSAL' }, 'KIOSK', now);
      flags.push('SIN_ASIGNACION_SUCURSAL');
    }
    await this.audit.record(tx, ctx, {
      action: 'attendance.clock_in',
      entityType: 'work_session',
      entityId: session!.id,
      branchId: device.branchId,
      after: { eventId: event.id, startedAt: now, shiftId: shift?.id ?? null, operationalDate: opDate, arrivalDeltaMinutes, flags },
    });
    return { action: 'CLOCK_IN' as const, occurredAt: now, replayed: false, workSessionId: session!.id, arrivalDeltaMinutes, shift: shiftSummary(shift ?? null), flags };
  }

  private async breakStart(b: { ctx: TenantContext; tx: Tx; device: KioskDevice; deviceId: string; employeeId: string; now: Date; policy: EffectivePolicy; clientEventId: string }, session: SessionRow) {
    const list = await breaksOf(b.tx, [session.id]);
    if (list.some((x) => x.endedAt === null)) throw new DomainError('BREAK_ALREADY_OPEN');
    if (list.length >= b.policy.maxBreaks) throw new DomainError('MAX_BREAKS_REACHED', { maxBreaks: b.policy.maxBreaks }); // D-14: política, no modelo
    const [brk] = await b.tx
      .insert(breaks)
      .values({
        organizationId: b.ctx.organizationId,
        workSessionId: session.id,
        sequence: list.length + 1,
        startedAt: b.now,
        allowedMinutes: b.policy.breakAllowedMin,
        toleranceMinutes: b.policy.breakToleranceMin,
        origin: 'KIOSK',
      })
      .returning();
    const event = await this.recordEvent(b, 'BREAK_START', session.id, brk!.id);
    await this.bumpSession(b.tx, session.id);
    await this.audit.record(b.tx, b.ctx, { action: 'attendance.break_started', entityType: 'work_session', entityId: session.id, branchId: session.branchId, after: { eventId: event.id, breakId: brk!.id, sequence: brk!.sequence, startedAt: b.now } });
    return { action: 'BREAK_START' as const, occurredAt: b.now, replayed: false, workSessionId: session.id, break: { sequence: brk!.sequence, allowedMinutes: brk!.allowedMinutes } };
  }

  private async breakEnd(b: { ctx: TenantContext; tx: Tx; device: KioskDevice; deviceId: string; employeeId: string; now: Date; policy: EffectivePolicy; clientEventId: string }, session: SessionRow) {
    const [open] = await b.tx.select().from(breaks).where(and(eq(breaks.workSessionId, session.id), sql`${breaks.endedAt} IS NULL`)).for('update');
    if (!open) throw new DomainError('NO_OPEN_BREAK');
    const [closed] = await b.tx
      .update(breaks)
      .set({ endedAt: b.now, version: open.version + 1 })
      .where(and(eq(breaks.id, open.id), sql`${breaks.endedAt} IS NULL`))
      .returning();
    const event = await this.recordEvent(b, 'BREAK_END', session.id, open.id);
    await this.bumpSession(b.tx, session.id);
    if ((closed!.exceededMinutes ?? 0) > 0) {
      // D-49: solo control de tiempo e incidencia; no toca horas, sueldo ni nómina
      await openIncident(
        b.tx,
        b.ctx,
        { type: 'COMIDA_EXCEDIDA', branchId: session.branchId, employeeId: session.employeeId, operationalDate: session.operationalDate, workSessionId: session.id, shiftId: session.shiftId, details: { breakId: closed!.id, sequence: closed!.sequence, durationMinutes: closed!.durationMinutes, allowedMinutes: closed!.allowedMinutes, exceededMinutes: closed!.exceededMinutes } },
        'KIOSK',
        b.now,
      );
    }
    await this.audit.record(b.tx, b.ctx, { action: 'attendance.break_ended', entityType: 'work_session', entityId: session.id, branchId: session.branchId, after: { eventId: event.id, breakId: open.id, endedAt: b.now, durationMinutes: closed!.durationMinutes, exceededMinutes: closed!.exceededMinutes } });
    return { action: 'BREAK_END' as const, occurredAt: b.now, replayed: false, workSessionId: session.id, break: { sequence: closed!.sequence, durationMinutes: closed!.durationMinutes, allowedMinutes: closed!.allowedMinutes, exceededMinutes: closed!.exceededMinutes } };
  }

  private async clockOut(b: { ctx: TenantContext; tx: Tx; device: KioskDevice; deviceId: string; employeeId: string; now: Date; policy: EffectivePolicy; clientEventId: string }, session: SessionRow) {
    // D-50: con una pausa abierta no se inventan eventos; primero "Regreso de comer"
    const list = await breaksOf(b.tx, [session.id]);
    if (list.some((x) => x.endedAt === null)) throw new DomainError('BREAK_OPEN');
    const [closed] = await b.tx
      .update(workSessions)
      .set({ endedAt: b.now, status: 'CLOSED', version: sql`${workSessions.version} + 1` })
      .where(and(eq(workSessions.id, session.id), eq(workSessions.status, 'OPEN')))
      .returning();
    if (!closed) throw new DomainError('NO_OPEN_SESSION');
    const event = await this.recordEvent(b, 'CLOCK_OUT', session.id);
    // D-67 / D-68: al cerrar se evalúan salida anticipada y sin comida (con el snapshot de la jornada)
    await syncDerivedIncidents(b.tx, b.ctx, session.id, b.now, { detectedBy: 'KIOSK', currentPolicy: () => this.policy(b.tx, b.ctx, session.branchId, session.employeeId) });
    const shift: ShiftRow | null = await loadShift(b.tx, session.shiftId);
    const elapsedMinutes = minutesBetween(session.startedAt, b.now);
    await this.audit.record(b.tx, b.ctx, { action: 'attendance.clock_out', entityType: 'work_session', entityId: session.id, branchId: session.branchId, before: { status: 'OPEN' }, after: { eventId: event.id, status: 'CLOSED', endedAt: b.now, elapsedMinutes } });
    return {
      action: 'CLOCK_OUT' as const,
      occurredAt: b.now,
      replayed: false,
      workSessionId: session.id,
      elapsedMinutes,
      departureDeltaMinutes: shift ? minutesBetween(shift.endsAt, b.now) : null,
    };
  }
}

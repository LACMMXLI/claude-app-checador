import { and, asc, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { DomainError } from '../../common/errors.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';
import { addDaysToDate } from '../../common/zoned-time.js';
import {
  attendanceEvents,
  auditLog,
  branches,
  corrections,
  employees,
  incidents,
  kioskDevices,
  shifts,
  users,
  weeklySchedules,
  workSessions,
} from '../../db/schema/index.js';
import type { AccessProfile } from '../auth/rbac.service.js';
import type { EffectivePolicy } from '../policies/policy.js';
import type { PoliciesService } from '../policies/policies.service.js';
import {
  type IncidentRow,
  REVIEW_INCIDENTS,
  type SessionRow,
  type ShiftRow,
  breakView,
  breaksOf,
  loadBranch,
  loadShift,
  sessionView,
  shiftSummary,
} from './attendance-common.js';
import { isLate, pendingArrivalState } from './attendance-time.js';
import { operationalDateIn } from '../../common/operational-day.js';

/** Estado de una fila del tablero (D-60). Se DERIVA de turno publicado + hora + política + jornada real. */
export type BoardState =
  | 'UPCOMING'
  | 'WITHIN_TOLERANCE'
  | 'LATE_NOT_ARRIVED'
  | 'ABSENT_NOT_ARRIVED'
  | 'MISSED'
  | 'WORKING'
  | 'ON_BREAK'
  | 'LEFT'
  | 'NEEDS_REVIEW';

const sessionState = (s: SessionRow, onBreak: boolean): BoardState =>
  s.status === 'REVIEW' ? 'NEEDS_REVIEW' : s.status === 'CLOSED' ? 'LEFT' : onBreak ? 'ON_BREAK' : 'WORKING';

/**
 * Consultas de asistencia para el panel: tablero en vivo, jornadas, detalle (programado / registrado /
 * efectivo), historial por empleado e incidencias. Siempre dentro del negocio (RLS) y del alcance por
 * sucursal donde OCURRIÓ la jornada (RN-SUC-08). Los estados efímeros no se guardan: se derivan.
 */
export class AttendanceQueryService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly policies: PoliciesService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private assertBranch(access: AccessProfile, branchId: string) {
    if (!access.can('attendance.view', branchId)) throw new DomainError('BRANCH_NOT_FOUND');
  }

  private visible(access: AccessProfile) {
    return access.branchesFor('attendance.view');
  }

  private async names(tx: Tx, employeeIds: string[]) {
    if (!employeeIds.length) return new Map<string, { firstName: string; lastName: string | null; employeeNumber: string }>();
    const rows = await tx
      .select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName, employeeNumber: employees.employeeNumber })
      .from(employees)
      .where(inArray(employees.id, [...new Set(employeeIds)]));
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async branchNames(tx: Tx) {
    return new Map((await tx.select({ id: branches.id, name: branches.name }).from(branches)).map((b) => [b.id, b.name]));
  }

  private async incidentsFor(tx: Tx, where: { sessionIds?: string[]; shiftIds?: string[] }) {
    const conds = [];
    if (where.sessionIds?.length) conds.push(inArray(incidents.workSessionId, where.sessionIds));
    if (where.shiftIds?.length) conds.push(inArray(incidents.shiftId, where.shiftIds));
    if (!conds.length) return [];
    return tx.select().from(incidents).where(or(...conds)).orderBy(asc(incidents.detectedAt));
  }

  private incidentView(i: IncidentRow) {
    return {
      id: i.id,
      type: i.type,
      status: i.status,
      details: i.details,
      detectedAt: i.detectedAt,
      detectedBy: i.detectedBy,
      resolution: i.resolution,
      resolutionSource: i.resolutionSource,
      resolvedAt: i.resolvedAt,
      resolutionReason: i.resolutionReason,
      version: i.version,
      workSessionId: i.workSessionId,
      shiftId: i.shiftId,
      branchId: i.branchId,
      employeeId: i.employeeId,
      operationalDate: i.operationalDate,
    };
  }

  /**
   * D-78 · "Hoy" para los filtros del panel: el día operativo de la sucursal (zona + hora de corte de su política) o,
   * sin sucursal, el del negocio. Lo calcula el servidor; el navegador nunca deduce la fecha por su cuenta.
   */
  async today(ctx: TenantContext, access: AccessProfile, branchId?: string) {
    if (branchId) this.assertBranch(access, branchId);
    else {
      const scope = access.branchesFor('attendance.view');
      if (scope !== 'ALL' && scope.size === 0) throw new DomainError('FORBIDDEN', { permission: 'attendance.view' });
    }
    return this.tenantDb.run(ctx, async (tx) => {
      const calendar = await this.policies.calendarTx(tx, ctx, branchId);
      return { today: operationalDateIn(this.clock(), calendar), timezone: calendar.timezone, cutoff: calendar.cutoff.slice(0, 5) };
    });
  }

  // ── tablero en vivo ─────────────────────────────────────────────────────────
  async board(ctx: TenantContext, access: AccessProfile, branchId: string, date?: string) {
    this.assertBranch(access, branchId);
    const now = this.clock();
    return this.tenantDb.run(ctx, async (tx) => {
      const branch = await loadBranch(tx, branchId);
      // D-78: "hoy" = día operativo de la sucursal (zona + hora de corte); los turnos se agrupan por SU día operativo
      const today = operationalDateIn(now, await this.policies.calendarTx(tx, ctx, branchId));
      const day = date ?? today;

      const shiftRows = await tx
        .select({ shift: shifts })
        .from(shifts)
        .innerJoin(weeklySchedules, eq(weeklySchedules.id, shifts.scheduleId))
        .where(and(eq(shifts.branchId, branchId), eq(shifts.operationalDate, day), eq(shifts.status, 'SCHEDULED'), eq(weeklySchedules.status, 'PUBLISHED')))
        .orderBy(asc(shifts.startsAt));
      const dayShifts = shiftRows.map((r) => r.shift);
      const sessions = await tx
        .select()
        .from(workSessions)
        .where(
          and(
            eq(workSessions.branchId, branchId),
            or(
              eq(workSessions.operationalDate, day),
              dayShifts.length ? inArray(workSessions.shiftId, dayShifts.map((s) => s.id)) : undefined,
              // turnos nocturnos de "ayer" que siguen abiertos o pendientes de corrección (RN-RT-01)
              day === today ? and(inArray(workSessions.status, ['OPEN', 'REVIEW']), lte(workSessions.operationalDate, day)) : undefined,
            ),
          ),
        )
        .orderBy(asc(workSessions.startedAt));
      const allBreaks = await breaksOf(tx, sessions.map((s) => s.id));
      const incs = await this.incidentsFor(tx, { sessionIds: sessions.map((s) => s.id), shiftIds: dayShifts.map((s) => s.id) });
      const people = await this.names(tx, [...dayShifts.map((s) => s.employeeId), ...sessions.map((s) => s.employeeId)]);
      const policyCache = new Map<string, EffectivePolicy>();
      const policyOf = async (employeeId: string) => {
        if (!policyCache.has(employeeId)) policyCache.set(employeeId, (await this.policies.getEffectiveTx(tx, ctx, { branchId, employeeId })).policy);
        return policyCache.get(employeeId)!;
      };

      const rows: Awaited<ReturnType<AttendanceQueryService['boardRow']>>[] = [];
      const used = new Set<string>();
      for (const shift of dayShifts) {
        const session = sessions.find((s) => s.shiftId === shift.id) ?? null;
        if (session) used.add(session.id);
        rows.push(await this.boardRow(shift, session, allBreaks, incs, await policyOf(shift.employeeId), now, people));
      }
      for (const session of sessions) {
        if (used.has(session.id)) continue;
        const shift = session.shiftId ? await loadShift(tx, session.shiftId) : null;
        rows.push(await this.boardRow(shift, session, allBreaks, incs, await policyOf(session.employeeId), now, people));
      }
      const count = (...states: BoardState[]) => rows.filter((r) => states.includes(r.state)).length;
      return {
        branch: { id: branch.id, name: branch.name, timezone: branch.timezone },
        operationalDate: day,
        isToday: day === today,
        serverTime: now,
        counters: {
          scheduled: dayShifts.length,
          upcoming: count('UPCOMING'),
          notArrived: count('WITHIN_TOLERANCE', 'LATE_NOT_ARRIVED'),
          late: rows.filter((r) => r.state === 'LATE_NOT_ARRIVED' || r.late).length,
          absent: count('ABSENT_NOT_ARRIVED'),
          working: count('WORKING'),
          onBreak: count('ON_BREAK'),
          needsReview: count('NEEDS_REVIEW'),
          left: count('LEFT'),
          missed: count('MISSED'),
          unscheduled: rows.filter((r) => r.session && !r.shift).length,
        },
        rows,
      };
    });
  }

  private async boardRow(
    shift: ShiftRow | null,
    session: SessionRow | null,
    allBreaks: Awaited<ReturnType<typeof breaksOf>>,
    incs: IncidentRow[],
    policy: EffectivePolicy,
    now: Date,
    people: Awaited<ReturnType<AttendanceQueryService['names']>>,
  ) {
    const employeeId = (session?.employeeId ?? shift?.employeeId)!;
    const sb = session ? allBreaks.filter((b) => b.workSessionId === session.id) : [];
    const view = session ? sessionView(session, sb, shift, now) : null;
    const state: BoardState = session ? sessionState(session, view!.onBreak) : pendingArrivalState(shift!, now, policy);
    const tolerance = (session?.policySnapshot as { entryToleranceMin?: number } | undefined)?.entryToleranceMin ?? policy.entryToleranceMin;
    const delta = view?.metrics.arrivalDeltaMinutes ?? null;
    const rowIncidents = incs.filter((i) => (session && i.workSessionId === session.id) || (shift && !i.workSessionId && i.shiftId === shift.id));
    const openBreak = sb.find((b) => b.endedAt === null);
    return {
      employee: { id: employeeId, ...people.get(employeeId) },
      shift: shiftSummary(shift),
      session: view,
      state,
      arrivalDeltaMinutes: delta,
      late: delta !== null && isLate(delta, tolerance),
      /** Minutos en comida de la pausa en curso (para "En comida", rojo si excede). */
      currentBreak: openBreak
        ? { startedAt: openBreak.startedAt, minutes: Math.max(0, Math.floor(now.getTime() / 60_000) - Math.floor(openBreak.startedAt.getTime() / 60_000)), allowedMinutes: openBreak.allowedMinutes }
        : null,
      incidents: rowIncidents.map((i) => ({ id: i.id, type: i.type, status: i.status })),
      requiresCorrection: rowIncidents.some((i) => i.status === 'OPEN' && (REVIEW_INCIDENTS as string[]).includes(i.type)),
    };
  }

  // ── listado de jornadas ─────────────────────────────────────────────────────
  async listSessions(
    ctx: TenantContext,
    access: AccessProfile,
    filter: { branchId?: string; from: string; to: string; employeeId?: string; status?: 'OPEN' | 'REVIEW' | 'CLOSED'; onlyWithIncidents?: boolean },
  ) {
    if (filter.branchId) this.assertBranch(access, filter.branchId);
    const scope = this.visible(access);
    if (scope !== 'ALL' && scope.size === 0) throw new DomainError('FORBIDDEN', { permission: 'attendance.view' });
    const now = this.clock();
    return this.tenantDb.run(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(workSessions)
        .where(
          and(
            gte(workSessions.operationalDate, filter.from),
            lte(workSessions.operationalDate, filter.to),
            filter.branchId ? eq(workSessions.branchId, filter.branchId) : scope === 'ALL' ? undefined : inArray(workSessions.branchId, [...scope]),
            filter.employeeId ? eq(workSessions.employeeId, filter.employeeId) : undefined,
            filter.status ? eq(workSessions.status, filter.status) : undefined,
          ),
        )
        .orderBy(desc(workSessions.operationalDate), desc(workSessions.startedAt))
        .limit(500);
      return this.sessionRows(tx, rows, now, filter.onlyWithIncidents);
    });
  }

  private async sessionRows(tx: Tx, rows: SessionRow[], now: Date, onlyWithIncidents?: boolean) {
    const ids = rows.map((r) => r.id);
    const allBreaks = await breaksOf(tx, ids);
    const incs = await this.incidentsFor(tx, { sessionIds: ids });
    const corrs = ids.length
      ? await tx.select({ sessionId: corrections.workSessionId, at: corrections.correctedAt, by: corrections.correctedBy }).from(corrections).where(inArray(corrections.workSessionId, ids))
      : [];
    const shiftIds = rows.map((r) => r.shiftId).filter((x): x is string => Boolean(x));
    const shiftRows = shiftIds.length ? await tx.select().from(shifts).where(inArray(shifts.id, shiftIds)) : [];
    const people = await this.names(tx, rows.map((r) => r.employeeId));
    const branchNames = await this.branchNames(tx);
    const correctors = await this.userNames(tx, corrs.map((c) => c.by));
    return rows
      .map((s) => {
        const shift = shiftRows.find((x) => x.id === s.shiftId) ?? null;
        const mine = incs.filter((i) => i.workSessionId === s.id);
        const myCorrections = corrs.filter((c) => c.sessionId === s.id).sort((a, b) => a.at.getTime() - b.at.getTime());
        const last = myCorrections[myCorrections.length - 1];
        return {
          ...sessionView(s, allBreaks.filter((b) => b.workSessionId === s.id), shift, now),
          employee: { id: s.employeeId, ...people.get(s.employeeId) },
          branchName: branchNames.get(s.branchId) ?? null,
          shift: shiftSummary(shift),
          incidents: mine.map((i) => ({ id: i.id, type: i.type, status: i.status })),
          requiresCorrection: mine.some((i) => i.status === 'OPEN' && (REVIEW_INCIDENTS as string[]).includes(i.type)),
          corrections: { count: myCorrections.length, lastAt: last?.at ?? null, lastBy: last ? (correctors.get(last.by) ?? null) : null },
        };
      })
      .filter((r) => !onlyWithIncidents || r.incidents.some((i) => i.status === 'OPEN'));
  }

  private async userNames(tx: Tx, ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const rows = await tx.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, [...new Set(ids)]));
    return new Map(rows.map((r) => [r.id, r.displayName]));
  }

  // ── detalle: Programado / Registrado / Efectivo ─────────────────────────────
  async sessionDetail(ctx: TenantContext, access: AccessProfile, sessionId: string) {
    const now = this.clock();
    return this.tenantDb.run(ctx, async (tx) => {
      const [s] = await tx.select().from(workSessions).where(eq(workSessions.id, sessionId));
      if (!s || !access.can('attendance.view', s.branchId)) throw new DomainError('SESSION_NOT_FOUND');
      const shift = await loadShift(tx, s.shiftId);
      const list = await breaksOf(tx, [s.id]);
      const events = await tx
        .select({ event: attendanceEvents, deviceName: kioskDevices.name, branchName: branches.name })
        .from(attendanceEvents)
        .innerJoin(kioskDevices, eq(kioskDevices.id, attendanceEvents.deviceId))
        .innerJoin(branches, eq(branches.id, attendanceEvents.branchId))
        .where(eq(attendanceEvents.workSessionId, s.id))
        .orderBy(asc(attendanceEvents.occurredAt));
      const incs = await this.incidentsFor(tx, { sessionIds: [s.id], shiftIds: s.shiftId ? [s.shiftId] : [] });
      const corrs = await tx.select().from(corrections).where(eq(corrections.workSessionId, s.id)).orderBy(asc(corrections.correctedAt));
      const correctors = await this.userNames(tx, corrs.map((c) => c.correctedBy));
      const audits = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, 'work_session'), eq(auditLog.entityId, s.id)))
        .orderBy(asc(auditLog.id));
      const auditors = await this.userNames(tx, audits.map((a) => a.actorUserId).filter((x): x is string => Boolean(x)));
      const people = await this.names(tx, [s.employeeId]);
      const branch = await loadBranch(tx, s.branchId);
      // turnos oficiales que podrían ligarse (corrección "asociación de jornada")
      const linkable = s.shiftId
        ? []
        : (
            await tx
              .select({ shift: shifts })
              .from(shifts)
              .innerJoin(weeklySchedules, eq(weeklySchedules.id, shifts.scheduleId))
              .where(
                and(
                  eq(shifts.employeeId, s.employeeId),
                  eq(shifts.branchId, s.branchId),
                  eq(shifts.status, 'SCHEDULED'),
                  eq(weeklySchedules.status, 'PUBLISHED'),
                  gte(shifts.operationalDate, addDaysToDate(s.operationalDate, -1)),
                  lte(shifts.operationalDate, addDaysToDate(s.operationalDate, 1)),
                  sql`NOT EXISTS (SELECT 1 FROM attendance.work_sessions ws WHERE ws.shift_id = ${shifts.id})`,
                ),
              )
          ).map((r) => shiftSummary(r.shift));
      const isSelf = Boolean(access.employeeId && access.employeeId === s.employeeId);
      return {
        employee: { id: s.employeeId, ...people.get(s.employeeId) },
        branch: { id: branch.id, name: branch.name, timezone: branch.timezone },
        /** Programado: lo que debía trabajar. */
        scheduled: shiftSummary(shift),
        /** Registrado: eventos físicos originales del kiosco (inmutables). */
        recorded: events.map((e) => ({
          id: e.event.id,
          type: e.event.type,
          occurredAt: e.event.occurredAt,
          receivedAt: e.event.receivedAt,
          source: e.event.source,
          device: e.deviceName,
          branchName: e.branchName,
          breakId: e.event.breakId,
        })),
        /** Efectivo: valores después de correcciones (lo que usan los reportes). */
        effective: sessionView(s, list, shift, now),
        breaks: list.map(breakView),
        incidents: incs.map((i) => this.incidentView(i)),
        corrections: corrs.map((c) => ({
          id: c.id,
          action: c.action,
          breakId: c.breakId,
          originalValue: c.originalValue,
          correctedValue: c.correctedValue,
          before: c.before,
          after: c.after,
          reason: c.reason,
          correctedAt: c.correctedAt,
          correctedBy: { id: c.correctedBy, displayName: correctors.get(c.correctedBy) ?? null },
        })),
        audit: audits.map((a) => ({ id: a.id, action: a.action, occurredAt: a.occurredAt, actorType: a.actorType, actor: a.actorUserId ? (auditors.get(a.actorUserId) ?? null) : null, before: a.before, after: a.after, reason: a.reason })),
        linkableShifts: linkable,
        permissions: {
          canCorrect: access.can('attendance.correction.apply', s.branchId) && !isSelf,
          canResolveIncidents: access.can('incidents.resolve', s.branchId) && !isSelf,
          isSelf,
        },
      };
    });
  }

  // ── historial por empleado (D-61) ───────────────────────────────────────────
  async employeeHistory(ctx: TenantContext, access: AccessProfile, employeeId: string, from: string, to: string) {
    const scope = this.visible(access);
    if (scope !== 'ALL' && scope.size === 0) throw new DomainError('FORBIDDEN', { permission: 'attendance.view' });
    const now = this.clock();
    return this.tenantDb.run(ctx, async (tx) => {
      const [emp] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.id, employeeId));
      if (!emp) throw new DomainError('EMPLOYEE_NOT_FOUND');
      const inScope = (branchId: string) => scope === 'ALL' || scope.has(branchId);
      const sessions = (
        await tx
          .select()
          .from(workSessions)
          .where(and(eq(workSessions.employeeId, employeeId), gte(workSessions.operationalDate, from), lte(workSessions.operationalDate, to)))
          .orderBy(desc(workSessions.operationalDate), desc(workSessions.startedAt))
      ).filter((s) => inScope(s.branchId));
      const rows = await this.sessionRows(tx, sessions, now);
      // Faltas (turno oficial sin jornada): también forman parte del historial
      const absences = (
        await tx
          .select({ incident: incidents, shift: shifts })
          .from(incidents)
          .innerJoin(shifts, eq(shifts.id, incidents.shiftId))
          .where(and(eq(incidents.employeeId, employeeId), eq(incidents.type, 'FALTA'), gte(incidents.operationalDate, from), lte(incidents.operationalDate, to)))
      ).filter((r) => inScope(r.incident.branchId));
      const branchNames = await this.branchNames(tx);
      return {
        sessions: rows,
        absences: absences.map((r) => ({
          ...this.incidentView(r.incident),
          branchName: branchNames.get(r.incident.branchId) ?? null,
          shift: shiftSummary(r.shift),
        })),
      };
    });
  }

  // ── incidencias ─────────────────────────────────────────────────────────────
  async listIncidents(ctx: TenantContext, access: AccessProfile, filter: { branchId?: string; status?: 'OPEN' | 'RESOLVED'; type?: string; from?: string; to?: string }) {
    if (filter.branchId) this.assertBranch(access, filter.branchId);
    const scope = this.visible(access);
    if (scope !== 'ALL' && scope.size === 0) throw new DomainError('FORBIDDEN', { permission: 'attendance.view' });
    return this.tenantDb.run(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(incidents)
        .where(
          and(
            filter.branchId ? eq(incidents.branchId, filter.branchId) : scope === 'ALL' ? undefined : inArray(incidents.branchId, [...scope]),
            filter.status ? eq(incidents.status, filter.status) : undefined,
            filter.type ? eq(incidents.type, filter.type) : undefined,
            filter.from ? gte(incidents.operationalDate, filter.from) : undefined,
            filter.to ? lte(incidents.operationalDate, filter.to) : undefined,
          ),
        )
        .orderBy(desc(incidents.operationalDate), desc(incidents.detectedAt))
        .limit(500);
      const people = await this.names(tx, rows.map((r) => r.employeeId));
      const branchNames = await this.branchNames(tx);
      const shiftIds = rows.map((r) => r.shiftId).filter((x): x is string => Boolean(x));
      const shiftRows = shiftIds.length ? await tx.select().from(shifts).where(inArray(shifts.id, shiftIds)) : [];
      return rows.map((i) => ({
        ...this.incidentView(i),
        employee: { id: i.employeeId, ...people.get(i.employeeId) },
        branchName: branchNames.get(i.branchId) ?? null,
        shift: shiftSummary(shiftRows.find((s) => s.id === i.shiftId) ?? null),
        canResolve: access.can('incidents.resolve', i.branchId) && !(access.employeeId && access.employeeId === i.employeeId),
        canCorrect: access.can('attendance.correction.apply', i.branchId) && !(access.employeeId && access.employeeId === i.employeeId),
      }));
    });
  }
}

import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { DomainError } from '../../common/errors.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';
import { effectiveTimezone } from '../../common/time.js';
import { toLocal } from '../../common/zoned-time.js';
import {
  branches,
  breaks,
  correctionRequests,
  corrections,
  employees,
  incidents,
  organizations,
  shifts,
  users,
  weeklySchedules,
  workSessions,
} from '../../db/schema/index.js';
import { minutesBetween, operationalDate, sessionMetrics } from '../attendance/attendance-time.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AccessProfile } from '../auth/rbac.service.js';
import type { PoliciesService } from '../policies/policies.service.js';
import { localView } from '../scheduling/shift-time.js';
import { MAX_EXPORTS_PER_MINUTE, MAX_EXPORT_ROWS, toCsv, toXlsx } from './export.js';
import {
  ACTION_LABELS,
  REPORT_TITLES,
  INCIDENT_LABELS,
  INCIDENT_STATUS_LABELS,
  ORIGIN_LABELS,
  REQUEST_STATUS_LABELS,
  RESOLUTION_LABELS,
  RESOLUTION_SOURCE_LABELS,
  SESSION_STATUS_LABELS,
  label,
} from './labels.js';
import { type PeriodKey, assertRange, quickPeriods } from './periods.js';

export type ReportKind = 'summary' | 'sessions' | 'incidents' | 'corrections';
export const REPORT_KINDS: readonly ReportKind[] = ['summary', 'sessions', 'incidents', 'corrections'];

export interface Column {
  key: string;
  header: string;
  kind: 'text' | 'number' | 'date';
}

export interface ReportTable {
  report: ReportKind;
  from: string;
  to: string;
  branchId: string | null;
  employeeId: string | null;
  columns: Column[];
  rows: Record<string, string | number | null>[];
}

export interface ReportFilter {
  report: ReportKind;
  period?: PeriodKey;
  from?: string;
  to?: string;
  branchId?: string;
  employeeId?: string;
}

/** Incidencias que cuentan como "reales" en totales: abiertas o confirmadas. Justificadas aparte; anuladas, corregidas
 * o descartadas no cuentan (F: siguen visibles en el reporte de incidencias). */
const REAL = (i: { status: string; resolution: string | null }) => i.status === 'OPEN' || i.resolution === 'CONFIRMED';
const JUSTIFIED = (i: { resolution: string | null }) => i.resolution === 'JUSTIFIED';

const localStamp = (d: Date | null, tz: string) => {
  if (!d) return null;
  const l = toLocal(d, tz);
  return `${l.date} ${l.time}`;
};

/**
 * Reportes de asistencia (D-73): siempre con valores EFECTIVOS, alcance por la sucursal donde ocurrió (y donde el
 * usuario tiene `reports.view`), por día operativo y en una lectura consistente (REPEATABLE READ, solo lectura).
 */
export class ReportsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly policies: PoliciesService,
    private readonly audit: AuditService,
    private readonly clock: () => Date = () => new Date(),
    private readonly limits: { maxRows: number; perMinute: number } = { maxRows: MAX_EXPORT_ROWS, perMinute: MAX_EXPORTS_PER_MINUTE },
  ) {}

  /** Sucursales sobre las que el usuario puede ver (o exportar) reportes. */
  scopeFor(access: AccessProfile, permission: 'reports.view' | 'reports.export', branchId?: string): 'ALL' | string[] {
    const scope = access.branchesFor(permission);
    if (branchId) {
      if (!access.can(permission, branchId)) throw new DomainError(permission === 'reports.view' ? 'BRANCH_NOT_FOUND' : 'FORBIDDEN', { permission });
      return [branchId];
    }
    if (scope === 'ALL') return 'ALL';
    if (scope.size === 0) throw new DomainError('FORBIDDEN', { permission });
    return [...scope];
  }

  /** Accesos rápidos calculados con el día operativo de la sucursal (o del negocio si son todas). */
  async periods(ctx: TenantContext, access: AccessProfile, branchId?: string) {
    this.scopeFor(access, 'reports.view', branchId);
    return this.tenantDb.runReadOnly(ctx, async (tx) => {
      const { today, timezone } = await this.today(tx, ctx, branchId);
      const { policy } = await this.policies.getEffectiveTx(tx, ctx, { branchId });
      return { today, timezone, periods: quickPeriods(today, policy.weekStartDay) };
    });
  }

  private async today(tx: Tx, ctx: TenantContext, branchId?: string) {
    const [org] = await tx.select({ tz: organizations.timezone }).from(organizations);
    let timezone = org!.tz;
    if (branchId) {
      const [b] = await tx.select({ tz: branches.timezone }).from(branches).where(eq(branches.id, branchId));
      if (!b) throw new DomainError('BRANCH_NOT_FOUND');
      timezone = effectiveTimezone(b.tz, org!.tz);
    }
    const { policy } = await this.policies.getEffectiveTx(tx, ctx, { branchId });
    return { today: operationalDate(this.clock(), timezone, policy.operationalCutoff), timezone };
  }

  /** Genera el reporte. `permission` = 'reports.export' para exportaciones (alcance de exportación). */
  async run(ctx: TenantContext, access: AccessProfile, filter: ReportFilter, permission: 'reports.view' | 'reports.export' = 'reports.view'): Promise<ReportTable> {
    const scope = this.scopeFor(access, permission, filter.branchId);
    if (permission === 'reports.export') this.scopeFor(access, 'reports.view', filter.branchId);
    return this.tenantDb.runReadOnly(ctx, async (tx) => {
      let { from, to } = filter;
      if (filter.period) {
        const { today } = await this.today(tx, ctx, filter.branchId);
        const { policy } = await this.policies.getEffectiveTx(tx, ctx, { branchId: filter.branchId });
        ({ from, to } = quickPeriods(today, policy.weekStartDay)[filter.period]);
      }
      if (!from || !to) throw new DomainError('VALIDATION_ERROR', { fields: ['from', 'to'] });
      assertRange(from, to);
      const ctxData = await this.load(tx, scope, from, to, filter.employeeId);
      const base = { report: filter.report, from, to, branchId: filter.branchId ?? null, employeeId: filter.employeeId ?? null };
      switch (filter.report) {
        case 'summary':
          return { ...base, ...this.summary(ctxData) };
        case 'sessions':
          return { ...base, ...this.sessions(ctxData) };
        case 'incidents':
          return { ...base, ...this.incidentsTable(ctxData) };
        case 'corrections':
          return { ...base, ...this.correctionsTable(ctxData) };
        default:
          throw new DomainError('VALIDATION_ERROR', { fields: ['report'] });
      }
    });
  }

  /**
   * Exportación XLSX/CSV (D-74, decisión 7). Requiere `reports.export` Y `reports.view` sobre el alcance. Límites:
   * rango ≤ 366 días, ≤ 100,000 filas, ≤ 10 exportaciones por minuto por usuario. El límite se cuenta con la propia
   * bitácora (`report.exported`): una verificación barata ANTES de consultar y la definitiva, serializada por usuario
   * con un candado de transacción, en la misma transacción que registra la exportación (sin carreras).
   */
  async export(ctx: TenantContext, access: AccessProfile, filter: ReportFilter, format: 'xlsx' | 'csv') {
    const userId = ctx.actor.userId;
    if (!userId) throw new DomainError('FORBIDDEN', { permission: 'reports.export' });
    const recent = (tx: Tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'report.exported' AND actor_user_id = ${userId} AND occurred_at > now() - interval '1 minute'`,
      );
    this.scopeFor(access, 'reports.export', filter.branchId);
    const pre = await this.tenantDb.run(ctx, recent);
    if (Number(pre.rows[0]?.n ?? 0) >= this.limits.perMinute) throw new DomainError('EXPORT_RATE_LIMITED', { perMinute: this.limits.perMinute });

    const table = await this.run(ctx, access, filter, 'reports.export');
    if (table.rows.length > this.limits.maxRows) throw new DomainError('EXPORT_TOO_LARGE', { maxRows: this.limits.maxRows, rows: table.rows.length });

    const meta = await this.tenantDb.run(ctx, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'report.export:' + userId}, 0))`);
      const n = Number((await recent(tx)).rows[0]?.n ?? 0);
      if (n >= this.limits.perMinute) throw new DomainError('EXPORT_RATE_LIMITED', { perMinute: this.limits.perMinute });
      const [org] = await tx.select({ name: organizations.name, tz: organizations.timezone }).from(organizations);
      const [branch] = table.branchId ? await tx.select({ name: branches.name, tz: branches.timezone }).from(branches).where(eq(branches.id, table.branchId)) : [];
      const [employee] = table.employeeId
        ? await tx.select({ n: employees.employeeNumber, f: employees.firstName, l: employees.lastName }).from(employees).where(eq(employees.id, table.employeeId))
        : [];
      const [me] = await tx.select({ n: users.displayName }).from(users).where(eq(users.id, userId));
      const timezone = effectiveTimezone(branch?.tz, org!.tz);
      await this.audit.record(tx, ctx, {
        action: 'report.exported',
        entityType: 'report',
        entityId: table.report,
        branchId: table.branchId,
        after: { report: table.report, format, from: table.from, to: table.to, period: filter.period ?? null, branchId: table.branchId, employeeId: table.employeeId, rows: table.rows.length },
      });
      return {
        organization: org!.name,
        branch: branch?.name ?? 'Todas las sucursales a mi cargo',
        employee: employee ? `${employee.n} · ${[employee.f, employee.l].filter(Boolean).join(' ')}` : null,
        generatedAt: localStamp(this.clock(), timezone)!,
        generatedBy: me?.n ?? '',
        timezone,
      };
    });

    const body = format === 'csv' ? toCsv(table) : await toXlsx(table, meta);
    const slug = (REPORT_TITLES[table.report] ?? table.report)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
    return {
      body,
      rows: table.rows.length,
      filename: `${slug}_${table.from}_${table.to}.${format}`,
      contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  /** Carga UNA foto de los datos del periodo, ya filtrada por alcance. */
  private async load(tx: Tx, scope: 'ALL' | string[], from: string, to: string, employeeId?: string) {
    const inScope = <T>(col: T) => (scope === 'ALL' ? undefined : inArray(col as never, scope));
    const byEmployee = <T>(col: T) => (employeeId ? eq(col as never, employeeId) : undefined);
    const [org] = await tx.select({ tz: organizations.timezone }).from(organizations);
    const branchRows = await tx.select({ id: branches.id, name: branches.name, tz: branches.timezone }).from(branches);
    const branchName = new Map(branchRows.map((b) => [b.id, b.name]));
    const branchTz = new Map(branchRows.map((b) => [b.id, effectiveTimezone(b.tz, org!.tz)]));
    const shiftRows = (
      await tx
        .select({ s: shifts })
        .from(shifts)
        .innerJoin(weeklySchedules, eq(weeklySchedules.id, shifts.scheduleId))
        .where(and(eq(shifts.status, 'SCHEDULED'), eq(weeklySchedules.status, 'PUBLISHED'), gte(shifts.businessDate, from), lte(shifts.businessDate, to), inScope(shifts.branchId), byEmployee(shifts.employeeId)))
    ).map((r) => r.s);
    const sessions = await tx
      .select()
      .from(workSessions)
      .where(and(gte(workSessions.operationalDate, from), lte(workSessions.operationalDate, to), inScope(workSessions.branchId), byEmployee(workSessions.employeeId)))
      .orderBy(asc(workSessions.operationalDate), asc(workSessions.startedAt));
    const sessionIds = sessions.map((s) => s.id);
    const breakRows = sessionIds.length ? await tx.select().from(breaks).where(inArray(breaks.workSessionId, sessionIds)).orderBy(asc(breaks.sequence)) : [];
    const linkedShiftIds = sessions.map((s) => s.shiftId).filter((x): x is string => Boolean(x));
    const linkedShifts = linkedShiftIds.length ? await tx.select().from(shifts).where(inArray(shifts.id, linkedShiftIds)) : [];
    const incidentRows = await tx
      .select()
      .from(incidents)
      .where(and(gte(incidents.operationalDate, from), lte(incidents.operationalDate, to), inScope(incidents.branchId), byEmployee(incidents.employeeId)))
      .orderBy(asc(incidents.operationalDate), asc(incidents.detectedAt));
    const correctionRows = sessionIds.length ? await tx.select().from(corrections).where(inArray(corrections.workSessionId, sessionIds)).orderBy(asc(corrections.correctedAt)) : [];
    const requestRows = await tx
      .select()
      .from(correctionRequests)
      .where(and(gte(correctionRequests.operationalDate, from), lte(correctionRequests.operationalDate, to), inScope(correctionRequests.branchId), byEmployee(correctionRequests.employeeId)))
      .orderBy(desc(correctionRequests.createdAt));
    const employeeIds = [...new Set([...shiftRows, ...sessions, ...incidentRows, ...requestRows].map((r) => r.employeeId))];
    const people = employeeIds.length
      ? new Map(
          (await tx.select({ id: employees.id, n: employees.employeeNumber, f: employees.firstName, l: employees.lastName }).from(employees).where(inArray(employees.id, employeeIds))).map((e) => [
            e.id,
            { number: e.n, name: [e.f, e.l].filter(Boolean).join(' ') },
          ]),
        )
      : new Map<string, { number: string; name: string }>();
    const userIds = [...new Set([...correctionRows.map((c) => c.correctedBy), ...incidentRows.map((i) => i.resolvedBy), ...requestRows.map((r) => r.decidedBy)].filter((x): x is string => Boolean(x)))];
    const userNames = userIds.length ? new Map((await tx.select({ id: users.id, n: users.displayName }).from(users).where(inArray(users.id, userIds))).map((u) => [u.id, u.n])) : new Map<string, string>();
    return { from, to, shiftRows, sessions, breakRows, linkedShifts, incidentRows, correctionRows, requestRows, people, userNames, branchName, branchTz, now: this.clock() };
  }

  private summary(d: Awaited<ReturnType<ReportsService['load']>>) {
    const columns: Column[] = [
      { key: 'employeeNumber', header: 'Número', kind: 'text' },
      { key: 'employee', header: 'Empleado', kind: 'text' },
      { key: 'scheduledShifts', header: 'Turnos programados', kind: 'number' },
      { key: 'sessions', header: 'Jornadas', kind: 'number' },
      { key: 'incompleteSessions', header: 'Jornadas incompletas', kind: 'number' },
      { key: 'scheduledMinutes', header: 'Minutos programados', kind: 'number' },
      { key: 'workedMinutes', header: 'Minutos reales (jornadas cerradas)', kind: 'number' },
      { key: 'absences', header: 'Faltas', kind: 'number' },
      { key: 'absencesJustified', header: 'Faltas justificadas', kind: 'number' },
      { key: 'lates', header: 'Retardos', kind: 'number' },
      { key: 'lateMinutes', header: 'Minutos de retardo', kind: 'number' },
      { key: 'latesJustified', header: 'Retardos justificados', kind: 'number' },
      { key: 'earlyLeaves', header: 'Salidas anticipadas', kind: 'number' },
      { key: 'earlyMinutes', header: 'Minutos de salida anticipada', kind: 'number' },
      { key: 'breaks', header: 'Pausas', kind: 'number' },
      { key: 'breakMinutes', header: 'Minutos de pausa', kind: 'number' },
      { key: 'breakExcessMinutes', header: 'Exceso de comida (min)', kind: 'number' },
      { key: 'noBreak', header: 'Sin comida', kind: 'number' },
      { key: 'unscheduled', header: 'Jornadas sin turno', kind: 'number' },
      { key: 'corrections', header: 'Correcciones', kind: 'number' },
      { key: 'pendingRequests', header: 'Solicitudes pendientes', kind: 'number' },
    ];
    const ids = [...d.people.keys()];
    const rows = ids
      .map((id) => {
        const mySessions = d.sessions.filter((s) => s.employeeId === id);
        const myIncidents = d.incidentRows.filter((i) => i.employeeId === id);
        const of = (type: string) => myIncidents.filter((i) => i.type === type);
        const metrics = mySessions.map((s) => sessionMetrics(s, null, d.breakRows.filter((b) => b.workSessionId === s.id), d.now));
        const sumDetail = (list: typeof myIncidents, key: string) => list.reduce((acc, i) => acc + Number((i.details as Record<string, unknown>)[key] ?? 0), 0);
        const lates = of('RETARDO').filter(REAL);
        const early = of('SALIDA_ANTICIPADA').filter(REAL);
        const mySessionIds = new Set(mySessions.map((s) => s.id));
        return {
          employeeNumber: d.people.get(id)!.number,
          employee: d.people.get(id)!.name,
          scheduledShifts: d.shiftRows.filter((s) => s.employeeId === id).length,
          sessions: mySessions.length,
          incompleteSessions: mySessions.filter((s) => s.status !== 'CLOSED').length,
          scheduledMinutes: d.shiftRows.filter((s) => s.employeeId === id).reduce((acc, s) => acc + minutesBetween(s.startsAt, s.endsAt), 0),
          workedMinutes: metrics.reduce((acc, m) => acc + (m.elapsedMinutes ?? 0), 0),
          absences: of('FALTA').filter(REAL).length,
          absencesJustified: of('FALTA').filter(JUSTIFIED).length,
          lates: lates.length,
          lateMinutes: sumDetail(lates, 'lateMinutes'),
          latesJustified: of('RETARDO').filter(JUSTIFIED).length,
          earlyLeaves: early.length,
          earlyMinutes: sumDetail(early, 'earlyMinutes'),
          breaks: metrics.reduce((acc, m) => acc + m.breakCount, 0),
          breakMinutes: metrics.reduce((acc, m) => acc + m.breakMinutes, 0),
          breakExcessMinutes: metrics.reduce((acc, m) => acc + m.breakExcessMinutes, 0),
          noBreak: of('SIN_COMIDA').filter(REAL).length,
          unscheduled: mySessions.filter((s) => !s.shiftId).length,
          corrections: d.correctionRows.filter((c) => mySessionIds.has(c.workSessionId)).length,
          pendingRequests: d.requestRows.filter((r) => r.employeeId === id && r.status === 'PENDING').length,
        };
      })
      .sort((a, b) => a.employee.localeCompare(b.employee, 'es'));
    return { columns, rows };
  }

  private sessions(d: Awaited<ReturnType<ReportsService['load']>>) {
    const columns: Column[] = [
      { key: 'operationalDate', header: 'Día operativo', kind: 'date' },
      { key: 'branch', header: 'Sucursal', kind: 'text' },
      { key: 'employeeNumber', header: 'Número', kind: 'text' },
      { key: 'employee', header: 'Empleado', kind: 'text' },
      { key: 'shift', header: 'Turno programado', kind: 'text' },
      { key: 'clockIn', header: 'Entrada', kind: 'text' },
      { key: 'clockOut', header: 'Salida', kind: 'text' },
      { key: 'arrivalDelta', header: 'Llegada vs turno (min)', kind: 'number' },
      { key: 'departureDelta', header: 'Salida vs turno (min)', kind: 'number' },
      { key: 'elapsedMinutes', header: 'Duración real (min)', kind: 'number' },
      { key: 'breaks', header: 'Pausas', kind: 'number' },
      { key: 'breakMinutes', header: 'Minutos de pausa', kind: 'number' },
      { key: 'breakExcessMinutes', header: 'Exceso de comida (min)', kind: 'number' },
      { key: 'status', header: 'Estado', kind: 'text' },
      { key: 'origin', header: 'Origen', kind: 'text' },
      { key: 'corrected', header: 'Corregida', kind: 'text' },
      { key: 'incidents', header: 'Incidencias', kind: 'text' },
      { key: 'timezone', header: 'Zona horaria', kind: 'text' },
    ];
    const rows: ReportTable['rows'] = d.sessions.map((s) => {
      const tz = d.branchTz.get(s.branchId) ?? 'UTC';
      const shift = d.linkedShifts.find((x) => x.id === s.shiftId) ?? null;
      const m = sessionMetrics(s, shift, d.breakRows.filter((b) => b.workSessionId === s.id), d.now);
      const local = shift ? localView(shift) : null;
      const mine = d.incidentRows.filter((i) => i.workSessionId === s.id && i.resolution !== 'VOIDED');
      return {
        operationalDate: s.operationalDate,
        branch: d.branchName.get(s.branchId) ?? null,
        employeeNumber: d.people.get(s.employeeId)?.number ?? null,
        employee: d.people.get(s.employeeId)?.name ?? null,
        shift: local ? `${local.startTime}–${local.endTime}${local.crossesMidnight ? ' (+1)' : ''}` : 'Sin turno',
        clockIn: localStamp(s.startedAt, tz),
        clockOut: localStamp(s.endedAt, tz),
        arrivalDelta: m.arrivalDeltaMinutes,
        departureDelta: m.departureDeltaMinutes,
        elapsedMinutes: m.elapsedMinutes,
        breaks: m.breakCount,
        breakMinutes: m.breakMinutes,
        breakExcessMinutes: m.breakExcessMinutes,
        status: label(SESSION_STATUS_LABELS, s.status),
        origin: label(ORIGIN_LABELS, s.origin),
        corrected: d.correctionRows.some((c) => c.workSessionId === s.id) ? 'Sí' : 'No',
        incidents: mine.map((i) => `${label(INCIDENT_LABELS, i.type)}${i.status === 'OPEN' ? '' : ` (${label(RESOLUTION_LABELS, i.resolution)})`}`).join('; '),
        timezone: tz,
      };
    });
    // Faltas: turnos oficiales sin jornada. Las anuladas por el sistema o corregidas no son faltas reales (F).
    for (const f of d.incidentRows.filter((i) => i.type === 'FALTA' && (REAL(i) || JUSTIFIED(i)))) {
      const shift = d.shiftRows.find((s) => s.id === f.shiftId);
      const local = shift ? localView(shift) : null;
      rows.push({
        operationalDate: f.operationalDate,
        branch: d.branchName.get(f.branchId) ?? null,
        employeeNumber: d.people.get(f.employeeId)?.number ?? null,
        employee: d.people.get(f.employeeId)?.name ?? null,
        shift: local ? `${local.startTime}–${local.endTime}${local.crossesMidnight ? ' (+1)' : ''}` : null,
        clockIn: null,
        clockOut: null,
        arrivalDelta: null,
        departureDelta: null,
        elapsedMinutes: null,
        breaks: null,
        breakMinutes: null,
        breakExcessMinutes: null,
        status: JUSTIFIED(f) ? 'Falta justificada' : 'Falta',
        origin: null,
        corrected: 'No',
        incidents: label(INCIDENT_LABELS, 'FALTA'),
        timezone: d.branchTz.get(f.branchId) ?? null,
      });
    }
    rows.sort((a, b) => String(a.operationalDate).localeCompare(String(b.operationalDate)) || String(a.employee).localeCompare(String(b.employee), 'es'));
    return { columns, rows };
  }

  private incidentsTable(d: Awaited<ReturnType<ReportsService['load']>>) {
    const columns: Column[] = [
      { key: 'operationalDate', header: 'Día operativo', kind: 'date' },
      { key: 'branch', header: 'Sucursal', kind: 'text' },
      { key: 'employeeNumber', header: 'Número', kind: 'text' },
      { key: 'employee', header: 'Empleado', kind: 'text' },
      { key: 'type', header: 'Incidencia', kind: 'text' },
      { key: 'minutes', header: 'Minutos', kind: 'number' },
      { key: 'status', header: 'Estado', kind: 'text' },
      { key: 'resolution', header: 'Resolución', kind: 'text' },
      { key: 'resolutionSource', header: 'Resuelta por (origen)', kind: 'text' },
      { key: 'resolvedBy', header: 'Resuelta por', kind: 'text' },
      { key: 'resolvedAt', header: 'Resuelta el', kind: 'text' },
      { key: 'reason', header: 'Motivo', kind: 'text' },
      { key: 'detectedAt', header: 'Detectada el', kind: 'text' },
    ];
    const rows = d.incidentRows.map((i) => {
      const tz = d.branchTz.get(i.branchId) ?? 'UTC';
      const details = i.details as Record<string, unknown>;
      const minutes = details.lateMinutes ?? details.earlyMinutes ?? details.elapsedMinutes ?? null;
      return {
        operationalDate: i.operationalDate,
        branch: d.branchName.get(i.branchId) ?? null,
        employeeNumber: d.people.get(i.employeeId)?.number ?? null,
        employee: d.people.get(i.employeeId)?.name ?? null,
        type: label(INCIDENT_LABELS, i.type),
        minutes: typeof minutes === 'number' ? minutes : null,
        status: label(INCIDENT_STATUS_LABELS, i.status),
        resolution: label(RESOLUTION_LABELS, i.resolution),
        resolutionSource: label(RESOLUTION_SOURCE_LABELS, i.resolutionSource),
        resolvedBy: i.resolvedBy ? (d.userNames.get(i.resolvedBy) ?? null) : i.resolutionSource === 'SYSTEM' ? 'Sistema' : null,
        resolvedAt: localStamp(i.resolvedAt, tz),
        reason: i.resolutionReason,
        detectedAt: localStamp(i.detectedAt, tz),
      };
    });
    return { columns, rows };
  }

  private correctionsTable(d: Awaited<ReturnType<ReportsService['load']>>) {
    const columns: Column[] = [
      { key: 'operationalDate', header: 'Día operativo', kind: 'date' },
      { key: 'branch', header: 'Sucursal', kind: 'text' },
      { key: 'employeeNumber', header: 'Número', kind: 'text' },
      { key: 'employee', header: 'Empleado', kind: 'text' },
      { key: 'kind', header: 'Tipo', kind: 'text' },
      { key: 'action', header: 'Acción', kind: 'text' },
      { key: 'value', header: 'Original → corregido / solicitado', kind: 'text' },
      { key: 'reason', header: 'Motivo', kind: 'text' },
      { key: 'by', header: 'Usuario', kind: 'text' },
      { key: 'at', header: 'Fecha', kind: 'text' },
      { key: 'decisionReason', header: 'Motivo de rechazo', kind: 'text' },
    ];
    const sessionsById = new Map(d.sessions.map((s) => [s.id, s]));
    const describe = (v: unknown, tz: string): string =>
      v && typeof v === 'object'
        ? Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== null && x !== undefined && typeof x !== 'object')
            .map(([k, x]) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x) ? `${k}: ${localStamp(new Date(x), tz)}` : `${k}: ${String(x)}`))
            .join(', ')
        : '';
    const rows: ReportTable['rows'] = d.correctionRows.map((c) => {
      const s = sessionsById.get(c.workSessionId)!;
      const tz = d.branchTz.get(c.branchId) ?? 'UTC';
      return {
        operationalDate: s.operationalDate,
        branch: d.branchName.get(c.branchId) ?? null,
        employeeNumber: d.people.get(c.employeeId)?.number ?? null,
        employee: d.people.get(c.employeeId)?.name ?? null,
        kind: c.requestId ? REQUEST_STATUS_LABELS.APPROVED! : 'Corrección directa',
        action: label(ACTION_LABELS, c.action),
        value: `${describe(c.originalValue, tz) || '—'} → ${describe(c.correctedValue, tz)}`,
        reason: c.reason,
        by: d.userNames.get(c.correctedBy) ?? null,
        at: localStamp(c.correctedAt, tz),
        decisionReason: null,
      };
    });
    for (const r of d.requestRows.filter((x) => x.status !== 'APPROVED')) {
      const tz = d.branchTz.get(r.branchId) ?? 'UTC';
      rows.push({
        operationalDate: r.operationalDate,
        branch: d.branchName.get(r.branchId) ?? null,
        employeeNumber: d.people.get(r.employeeId)?.number ?? null,
        employee: d.people.get(r.employeeId)?.name ?? null,
        kind: label(REQUEST_STATUS_LABELS, r.status),
        action: label(ACTION_LABELS, r.action),
        value: `→ ${localStamp(r.proposedStart, tz)}${r.proposedEnd ? ` – ${localStamp(r.proposedEnd, tz)}` : ''}`,
        reason: r.reason,
        by: r.decidedBy ? (d.userNames.get(r.decidedBy) ?? null) : null,
        at: localStamp(r.decidedAt ?? r.createdAt, tz),
        decisionReason: r.decisionReason,
      });
    }
    rows.sort((a, b) => String(a.operationalDate).localeCompare(String(b.operationalDate)));
    return { columns, rows };
  }
}

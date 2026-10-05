/**
 * Cliente del panel. Usa la cookie de sesión (HttpOnly) del mismo origen: nunca guarda tokens en
 * localStorage. Nunca envía `organization_id`: el negocio activo lo fija el servidor en la sesión.
 */
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly details: Record<string, unknown> = {}) {
    super(code);
  }
}

/** Cuántas peticiones que MODIFICAN datos (no GET) han terminado bien. Permite avisar "listo" solo cuando de verdad se guardó algo. */
let mutations = 0;
export const mutationCount = () => mutations;

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-requested-with': 'checador' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) {
    if (method !== 'GET' && res.ok) mutations += 1;
    return undefined as T;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'HTTP_ERROR', data?.error?.details ?? {});
  if (method !== 'GET') mutations += 1;
  return data as T;
}

export interface Me {
  user: { id: string; email: string; displayName: string };
  memberships: { organizationId: string; name: string; slug: string }[];
  activeOrganization: { id: string; name: string; branding: { logoUrl?: string; artUrl?: string } } | null;
  permissions: Record<string, 'ALL' | string[]>;
  /** Ficha de empleado ligada a la membresía activa (habilita "Mis jornadas"). */
  employeeId: string | null;
}

export interface Branch {
  id: string;
  code: string;
  name: string;
  timezone: string | null;
  effectiveTimezone: string;
  isActive: boolean;
}

export interface Employee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  primaryBranchId: string | null;
  branchIds: string[];
}

export interface Shift {
  id: string;
  scheduleId: string;
  scheduleStatus: 'DRAFT' | 'PUBLISHED' | null;
  branchId: string;
  employeeId: string;
  businessDate: string;
  /** D-78: día operativo del turno (el que usa toda la asistencia). */
  operationalDate: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  crossesMidnight: boolean;
  scheduledMinutes: number;
  status: 'SCHEDULED' | 'CANCELLED';
  cancelReason: string | null;
  notes: string | null;
  source: string;
  version: number;
}

export interface Week {
  branch: { id: string; name: string; timezone: string; isActive: boolean };
  weekStart: string;
  days: string[];
  schedule: { id: string; status: 'DRAFT' | 'PUBLISHED'; version: number; publishedAt: string | null } | null;
  employees: { id: string; employeeNumber: string; firstName: string; lastName: string; status: string; temporary: boolean }[];
  shifts: Shift[];
}

// ── Asistencia (Fase 3) ────────────────────────────────────────────────────────
export type PunchAction = 'CLOCK_IN' | 'BREAK_START' | 'BREAK_END' | 'CLOCK_OUT';

export interface ShiftSummary {
  id: string;
  branchId: string;
  branchName: string | null;
  businessDate: string;
  operationalDate: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  startTime: string;
  endTime: string;
  crossesMidnight: boolean;
  scheduledMinutes: number;
}

export interface BreakView {
  id: string;
  sequence: number;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
  allowedMinutes: number;
  exceededMinutes: number | null;
  version: number;
}

export interface Metrics {
  arrivalDeltaMinutes: number | null;
  departureDeltaMinutes: number | null;
  scheduledMinutes: number | null;
  elapsedMinutes: number | null;
  runningMinutes: number | null;
  breakCount: number;
  breakMinutes: number;
  breakExcessMinutes: number;
  openBreak: boolean;
}

export interface SessionView {
  id: string;
  branchId: string;
  employeeId: string;
  shiftId: string | null;
  operationalDate: string;
  startedAt: string;
  endedAt: string | null;
  status: 'OPEN' | 'REVIEW' | 'CLOSED';
  origin: 'KIOSK' | 'CORRECTION';
  version: number;
  onBreak: boolean;
  breaks: BreakView[];
  metrics: Metrics;
}

export interface IncidentRef {
  id: string;
  type: string;
  status: 'OPEN' | 'RESOLVED';
}

export interface PersonRef {
  id: string;
  firstName?: string;
  lastName?: string | null;
  employeeNumber?: string;
}

export interface BoardRow {
  employee: PersonRef;
  shift: ShiftSummary | null;
  session: SessionView | null;
  state: string;
  arrivalDeltaMinutes: number | null;
  late: boolean;
  currentBreak: { startedAt: string; minutes: number; allowedMinutes: number } | null;
  incidents: IncidentRef[];
  requiresCorrection: boolean;
}

export interface Board {
  branch: { id: string; name: string; timezone: string };
  operationalDate: string;
  isToday: boolean;
  serverTime: string;
  counters: Record<string, number>;
  rows: BoardRow[];
}

export interface SessionRow extends SessionView {
  employee: PersonRef;
  branchName: string | null;
  shift: ShiftSummary | null;
  incidents: IncidentRef[];
  requiresCorrection: boolean;
  corrections: { count: number; lastAt: string | null; lastBy: string | null };
}

export interface Incident {
  id: string;
  type: string;
  status: 'OPEN' | 'RESOLVED';
  details: Record<string, unknown>;
  detectedAt: string;
  resolution: string | null;
  resolutionSource?: 'USER' | 'CORRECTION' | 'SYSTEM' | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  version: number;
  workSessionId: string | null;
  shiftId: string | null;
  branchId: string;
  employeeId: string;
  operationalDate: string;
}

export interface SessionDetail {
  employee: PersonRef;
  branch: { id: string; name: string; timezone: string };
  scheduled: ShiftSummary | null;
  recorded: { id: string; type: PunchAction; occurredAt: string; receivedAt: string; source: string; device: string; branchName: string; breakId: string | null }[];
  effective: SessionView;
  breaks: BreakView[];
  incidents: Incident[];
  corrections: {
    id: string;
    action: string;
    breakId: string | null;
    originalValue: Record<string, unknown> | null;
    correctedValue: Record<string, unknown>;
    reason: string;
    correctedAt: string;
    correctedBy: { id: string; displayName: string | null };
  }[];
  audit: { id: number; action: string; occurredAt: string; actorType: string; actor: string | null; reason: string | null }[];
  linkableShifts: ShiftSummary[];
  permissions: { canCorrect: boolean; canResolveIncidents: boolean; isSelf: boolean };
}

export const personName = (p: PersonRef) => [p.firstName, p.lastName].filter(Boolean).join(' ') || p.id.slice(0, 8);

// ── Fase 4 ─────────────────────────────────────────────────────────────────────
export type RequestAction = 'SET_CLOCK_IN' | 'SET_CLOCK_OUT' | 'SET_BREAK_START' | 'SET_BREAK_END' | 'ADD_BREAK' | 'CREATE_SESSION';
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export interface LocalInstant {
  date: string;
  time: string;
}

export interface CorrectionRequest {
  id: string;
  branchId: string;
  branchName: string | null;
  employeeId: string;
  employee: PersonRef;
  operationalDate: string;
  action: RequestAction;
  workSessionId: string | null;
  breakId: string | null;
  shiftId: string | null;
  proposedStart: string;
  proposedEnd: string | null;
  proposedLocal: { start: LocalInstant; end?: LocalInstant | null; timezone?: string } | null;
  reason: string;
  channel: 'KIOSK' | 'PANEL';
  status: RequestStatus;
  decidedAt: string | null;
  decidedBy: { id: string; displayName: string | null } | null;
  decisionReason: string | null;
  correctionId: string | null;
  version: number;
  createdAt: string;
  canDecide: boolean;
}

export interface CorrectionRequestDetail extends CorrectionRequest {
  timezone: string;
  session: (SessionView & { shift: ShiftSummary | null }) | null;
  recorded: { type: PunchAction; occurredAt: string }[];
  shift: ShiftSummary | null;
}

/** "Mis registros" (kiosco) / "Mis jornadas" (panel): solo la propia ficha y la ventana de solicitud. */
export interface OwnRecords {
  window: { from: string; to: string; days: number };
  sessions: {
    id: string;
    operationalDate: string;
    branchId: string;
    branchName: string | null;
    timezone: string;
    startedAt: string;
    endedAt: string | null;
    status: 'OPEN' | 'REVIEW' | 'CLOSED';
    shift: { startTime: string; endTime: string; crossesMidnight: boolean } | null;
    breaks: { id: string; sequence: number; startedAt: string; endedAt: string | null }[];
  }[];
  absences: { shiftId: string; operationalDate: string; branchId: string; branchName: string | null; timezone: string; startTime: string | null; endTime: string | null; crossesMidnight: boolean }[];
  requests: { id: string; action: RequestAction; status: RequestStatus; operationalDate: string; workSessionId: string | null; shiftId: string | null; proposedLocal: CorrectionRequest['proposedLocal']; decisionReason: string | null; createdAt: string }[];
}

export interface RequestDraft {
  action: RequestAction;
  workSessionId?: string | null;
  breakId?: string | null;
  shiftId?: string | null;
  branchId?: string | null;
  start: LocalInstant;
  end?: LocalInstant | null;
  reason: string;
}

export type PeriodKey = 'today' | 'yesterday' | 'week_current' | 'week_previous' | 'fortnight_current' | 'fortnight_previous' | 'month_current' | 'month_previous';
export type ReportKind = 'summary' | 'sessions' | 'incidents' | 'corrections';
export interface ReportTable {
  report: ReportKind;
  from: string;
  to: string;
  columns: { key: string; header: string; kind: 'text' | 'number' | 'date' }[];
  rows: Record<string, string | number | null>[];
}

/** Descarga un archivo generado por un POST (exportaciones): el nombre lo da el servidor. */
export async function download(path: string, body: unknown): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'checador' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error?.code ?? 'HTTP_ERROR', data?.error?.details ?? {});
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'reporte';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

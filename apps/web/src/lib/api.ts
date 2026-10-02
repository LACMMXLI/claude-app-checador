/**
 * Cliente del panel. Usa la cookie de sesión (HttpOnly) del mismo origen: nunca guarda tokens en
 * localStorage. Nunca envía `organization_id`: el negocio activo lo fija el servidor en la sesión.
 */
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly details: Record<string, unknown> = {}) {
    super(code);
  }
}

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
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'HTTP_ERROR', data?.error?.details ?? {});
  return data as T;
}

export interface Me {
  user: { id: string; email: string; displayName: string };
  memberships: { organizationId: string; name: string; slug: string }[];
  activeOrganization: { id: string; name: string } | null;
  permissions: Record<string, 'ALL' | string[]>;
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

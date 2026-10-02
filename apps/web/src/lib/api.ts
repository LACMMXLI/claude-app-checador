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

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

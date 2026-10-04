/**
 * Cliente de la consola. Usa la cookie de sesión (HttpOnly) del mismo origen: nunca guarda tokens en localStorage.
 * Toda petición que modifica estado lleva `X-Requested-With: platform` (defensa CSRF).
 */
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly details: Record<string, unknown> = {}) {
    super(code);
  }
}

let mutations = 0;
/** Cuántas peticiones que MODIFICAN datos han terminado bien (para avisar "listo" solo cuando algo se guardó). */
export const mutationCount = () => mutations;

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-requested-with': 'platform' } : {}),
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

export type SubStatus = 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'CANCELLED';
export interface Limits { branches: number | null; employees: number | null; kiosks: number | null; members: number | null }
export interface Usage { branches: number; employees: number; kiosks: number; members: number }

export interface Operator { id: string; email: string; displayName: string }
export interface OperatorRow extends Operator { status: 'ACTIVE' | 'DISABLED'; lastLoginAt: string | null; createdAt: string }

export interface Plan {
  code: string;
  name: string;
  description: string;
  limits: Limits;
  features: { reportsExport: boolean; scheduleTemplates: boolean };
  sortOrder: number;
  isActive: boolean;
  customers: number;
}

export interface Customer {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  organizationStatus: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
  planCode: string;
  planName: string;
  status: SubStatus;
  effectiveStatus: SubStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  daysLeft: number | null;
  adminEmail: string | null;
  usage: Usage;
}
export interface CustomerDetail extends Customer {
  notes: string;
  limits: Limits;
  admins: { email: string; displayName: string; status: string }[];
  branches: { id: string; code: string; name: string; isActive: boolean }[];
  lastActivityAt: string | null;
}
export interface LimitWarning { resource: keyof Limits; limit: number; used: number }
export interface SubscriptionResult { subscription: { status: SubStatus; planCode: string }; warnings: LimitWarning[] }

export interface SubscriptionEvent { id: number; occurredAt: string; actor: string; event: string; fromPlan: string | null; toPlan: string | null; fromStatus: string | null; toStatus: string | null; details: Record<string, unknown> }
export interface AuditEntry { id: number; occurredAt: string; actor: string; action: string; organizationId: string | null; details: Record<string, unknown> }

export interface Dashboard {
  totals: { customers: number; employees: number; branches: number; kiosks: number };
  byStatus: Record<string, number>;
  byPlan: { planCode: string; planName: string; customers: number }[];
  expiringSoon: { id: string; name: string; slug: string; planCode: string; status: string; endsAt: string }[];
  recent: { id: string; name: string; slug: string; planCode: string; status: string; createdAt: string }[];
}

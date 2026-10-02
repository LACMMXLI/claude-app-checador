import { auditLog } from '../../db/schema/index.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx } from '../../common/tenancy/tenant-db.js';

export interface AuditEntry {
  action: string;               // p. ej. 'employee.pin_reset'
  entityType: string;           // p. ej. 'employee'
  entityId?: string;
  branchId?: string | null;     // solo cuando la acción pertenece a una sucursal
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/** Claves que NUNCA deben llegar a la bitácora (RN-AUD-06): PIN, hashes, contraseñas, tokens, secretos. */
const SENSITIVE = /(^pin$|pin_?hash|pin_?code|pairing_?code|password|passwd|secret|token|authorization|pepper)/i;

/** Copia profunda que reemplaza por "[REDACTED]" cualquier clave sensible. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.test(k) ? '[REDACTED]' : redact(v)]),
    );
  }
  return value;
}

export class AuditService {
  /**
   * Registra una acción EN LA MISMA TRANSACCIÓN que el cambio (RN-AUD-04). Siempre guarda el negocio
   * y, cuando aplica, la sucursal. La política RLS impide registrar con un negocio distinto al del contexto.
   */
  async record(tx: Tx, ctx: TenantContext, entry: AuditEntry): Promise<void> {
    await tx.insert(auditLog).values({
      organizationId: ctx.organizationId,
      branchId: entry.branchId ?? null,
      actorType: ctx.actor.type,
      actorUserId: ctx.actor.userId ?? null,
      actorDeviceId: ctx.actor.deviceId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: entry.before === undefined ? null : redact(entry.before),
      after: entry.after === undefined ? null : redact(entry.after),
      reason: entry.reason ?? null,
      ip: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    });
  }
}

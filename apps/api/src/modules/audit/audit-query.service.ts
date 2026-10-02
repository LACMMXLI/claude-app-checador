import { and, desc, eq, lt } from 'drizzle-orm';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { TenantDb } from '../../common/tenancy/tenant-db.js';
import { auditLog } from '../../db/schema/index.js';

/** Consulta de la auditoría DEL negocio activo (RLS). Paginación por id descendente. */
export class AuditQueryService {
  constructor(private readonly tenantDb: TenantDb) {}

  list(ctx: TenantContext, filter: { limit?: number; beforeId?: number; entityType?: string; entityId?: string; branchId?: string; action?: string } = {}) {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    return this.tenantDb.run(ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            filter.beforeId ? lt(auditLog.id, filter.beforeId) : undefined,
            filter.entityType ? eq(auditLog.entityType, filter.entityType) : undefined,
            filter.entityId ? eq(auditLog.entityId, filter.entityId) : undefined,
            filter.branchId ? eq(auditLog.branchId, filter.branchId) : undefined,
            filter.action ? eq(auditLog.action, filter.action) : undefined,
          ),
        )
        .orderBy(desc(auditLog.id))
        .limit(limit),
    );
  }
}

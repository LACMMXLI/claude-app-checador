import { desc, eq, lt, and, type SQL } from 'drizzle-orm';
import { PlatformDb, schema } from '@checador/api/platform';

const { platformAuditLog } = schema;

/** Bitácora de plataforma (solo-agregar): quién hizo qué, sobre qué cliente y cuándo. Nunca contiene contraseñas ni tokens. */
export class AuditService {
  constructor(private readonly db: PlatformDb) {}

  list(opts: { organizationId?: string; beforeId?: number; limit?: number } = {}) {
    const where: SQL[] = [];
    if (opts.organizationId) where.push(eq(platformAuditLog.organizationId, opts.organizationId));
    if (opts.beforeId) where.push(lt(platformAuditLog.id, opts.beforeId));
    return this.db.run((tx) =>
      tx.select().from(platformAuditLog).where(where.length ? and(...where) : undefined).orderBy(desc(platformAuditLog.id)).limit(Math.min(opts.limit ?? 50, 200)),
    );
  }
}

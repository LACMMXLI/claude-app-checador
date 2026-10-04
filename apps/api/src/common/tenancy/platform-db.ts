import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from '../../db/schema/index.js';
import type { Db, Tx } from './tenant-db.js';

/**
 * Acceso con el rol `platform_ops` (BYPASSRLS). SOLO para operaciones de plataforma (CLI interno).
 * La API HTTP nunca debe instanciarlo (lo vigila `test/architecture.test.ts`).
 */
export class PlatformDb {
  private readonly db: Db;

  constructor(pool: Pool) {
    this.db = drizzle(pool, { schema });
  }

  /**
   * `actor` queda en `app.platform_actor` durante la transacción: los triggers de plataforma (historial de
   * suscripciones) lo registran como responsable del cambio.
   */
  run<T>(fn: (tx: Tx) => Promise<T>, options: { actor?: string } = {}): Promise<T> {
    return this.db.transaction(async (tx) => {
      if (options.actor) await tx.execute(sql`SELECT set_config('app.platform_actor', ${options.actor}, true)`);
      return fn(tx);
    });
  }
}

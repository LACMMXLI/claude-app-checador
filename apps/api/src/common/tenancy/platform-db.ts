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

  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }
}

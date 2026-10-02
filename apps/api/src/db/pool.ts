import pg from 'pg';

const { Pool } = pg;
export type { Pool, PoolClient } from 'pg';

/**
 * Crea un pool. NO se importa desde los servicios de negocio: ellos reciben `TenantDb`
 * (que fija el contexto de negocio). Solo `common/tenancy`, `db` y `cli` pueden usar el pool crudo
 * (lo vigila `test/architecture.test.ts`).
 */
export function createPool(connectionString: string, max = 10): pg.Pool {
  return new Pool({ connectionString, max });
}

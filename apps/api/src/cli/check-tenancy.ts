import pg from 'pg';
import { requireEnv } from '../config/env.js';

/**
 * Verificación de catálogo para CI: toda tabla de negocio debe tener organization_id NOT NULL,
 * RLS habilitado y forzado y la política tenant_isolation. Sale con código 1 si hay violaciones.
 */
const client = new pg.Client({ connectionString: requireEnv('MIGRATOR_DATABASE_URL') });
await client.connect();
try {
  const { rows } = await client.query<{ table_name: string; problem: string }>(
    'SELECT table_name, problem FROM core.tenant_isolation_violations() ORDER BY 1, 2',
  );
  if (rows.length > 0) {
    console.error('✖ Violaciones de aislamiento multi-tenant:');
    for (const r of rows) console.error(`  - ${r.table_name}: ${r.problem}`);
    process.exitCode = 1;
  } else {
    console.log('✔ Aislamiento multi-tenant verificado: todas las tablas de negocio están protegidas.');
  }
} finally {
  await client.end();
}

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
/** `db/migrations` junto al código: funciona desde `src/db` (tsx/vitest) y desde `dist/src/db` (compilado). */
export const MIGRATIONS_DIR = [path.resolve(here, '../../db/migrations'), path.resolve(here, '../../../db/migrations')].find((d) => existsSync(d)) ?? path.resolve(here, '../../db/migrations');

const LOCK_KEY = 727_274; // pg_advisory_lock: una sola instancia migra a la vez

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Aplica las migraciones SQL (fuente de verdad del esquema) en orden, cada una en su transacción.
 * Idempotente: las ya aplicadas se omiten y su checksum se verifica (no se pueden editar).
 * Debe ejecutarse con el rol `migrator`.
 */
export async function migrate(connectionString: string, dir = MIGRATIONS_DIR): Promise<MigrateResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const result: MigrateResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const applied = new Map<string, string>(
      (await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM public.schema_migrations')).rows.map(
        (r) => [r.version, r.checksum],
      ),
    );
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`La migración ${file} ya fue aplicada y fue modificada (checksum distinto). Crea una migración nueva.`);
        }
        result.skipped.push(file);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Falló la migración ${file}: ${(error as Error).message}`);
      }
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

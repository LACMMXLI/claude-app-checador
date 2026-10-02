import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate } from '../src/db/migrate.js';
import { URLS } from './helpers/config.js';
import { openPools } from './helpers/world.js';

const pools = openPools();
afterAll(() => pools.close());

describe('migraciones', () => {
  it('son idempotentes: una segunda ejecución no aplica nada', async () => {
    const result = await migrate(URLS.migrator);
    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThanOrEqual(5);
  });

  it('rechazan una migración ya aplicada que fue modificada (checksum)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'migrations-'));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const file = path.join(dir, '0001_foundation.sql');
    await writeFile(file, `${await readFile(file, 'utf8')}\n-- cambio sospechoso\n`);
    await expect(migrate(URLS.migrator, dir)).rejects.toThrow(/modificada/);
  });

  it('dejan el esquema esperado (esquemas, extensión y funciones-puerta)', async () => {
    const schemas = await pools.superuser.query(`SELECT nspname FROM pg_namespace WHERE nspname IN ('platform','auth','core','audit')`);
    expect(schemas.rowCount).toBe(4);
    const fns = await pools.superuser.query(
      `SELECT p.proname, r.rolname AS owner, p.prosecdef FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname IN ('resolve_kiosk_token','redeem_pairing_code','get_login_record','record_login_result','list_user_memberships','list_active_organizations')`,
    );
    expect(fns.rowCount).toBe(6);
    for (const row of fns.rows) {
      expect(row.owner).toBe('gate_owner');
      expect(row.prosecdef).toBe(true);
    }
  });

  it('la base de datos usa UTC y no existe ninguna columna timestamp sin zona horaria', async () => {
    expect((await pools.app.query('SHOW timezone')).rows[0].TimeZone).toBe('UTC');
    const naive = await pools.superuser.query(
      `SELECT n.nspname, c.relname, a.attname FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE a.atttypid = 'timestamp'::regtype AND a.attnum > 0 AND NOT a.attisdropped
          AND n.nspname IN ('platform','auth','core','audit','public')`,
    );
    expect(naive.rows).toEqual([]);
  });
});

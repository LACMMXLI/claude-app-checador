import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema/index.js';
import { openPools } from './helpers/world.js';

const pools = openPools();
afterAll(() => pools.close());

describe('esquema Drizzle ↔ PostgreSQL migrado (sin deriva)', () => {
  const tables = Object.values(schema).filter((v) => typeof v === 'object' && v !== null && Symbol.for('drizzle:IsDrizzleTable') in (v as object));

  it('hay definiciones para todas las tablas de la Fases 0–2', () => {
    expect(tables.length).toBe(25);
  });

  it.each(tables.map((t) => {
    const cfg = getTableConfig(t as never);
    return [`${cfg.schema}.${cfg.name}`, cfg] as const;
  }))('%s: mismas columnas, nulabilidad y tipos básicos', async (_name, cfg) => {
    const { rows } = await pools.superuser.query(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [cfg.schema, cfg.name],
    );
    const db = new Map(rows.map((r) => [r.column_name as string, r]));
    expect([...db.keys()].sort()).toEqual(cfg.columns.map((c) => c.name).sort());
    for (const col of cfg.columns) {
      const actual = db.get(col.name)!;
      const notNull = actual.is_nullable === 'NO';
      expect(col.notNull || col.primary, `${cfg.name}.${col.name} nulabilidad`).toBe(notNull);
      if (col.columnType === 'PgTimestamp') expect(actual.data_type, `${cfg.name}.${col.name}`).toBe('timestamp with time zone');
    }
  });
});

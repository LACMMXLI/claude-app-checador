import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asTenant, count, pgError } from './helpers/sql.js';
import { buildWorld, openPools, seedOrganization, type SeededOrg } from './helpers/world.js';

const pools = openPools();
const world = buildWorld(pools);
let A: SeededOrg;
let B: SeededOrg;
let tables: string[] = [];

beforeAll(async () => {
  A = await seedOrganization(world, { slug: 'iso-a', timezone: 'America/Tijuana' });
  B = await seedOrganization(world, { slug: 'iso-b', timezone: 'America/Mexico_City' });
  // Todas las tablas con organization_id que no estén registradas como excepción
  const { rows } = await pools.superuser.query(
    `SELECT n.nspname || '.' || c.relname AS t
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped
      WHERE c.relkind = 'r' AND n.nspname IN ('core','audit','scheduling','attendance')
        AND NOT EXISTS (SELECT 1 FROM core.tenant_exempt_tables e WHERE e.table_schema = n.nspname AND e.table_name = c.relname)
      ORDER BY 1`,
  );
  tables = rows.map((r) => r.t as string);
});
afterAll(() => pools.close());

/** Columnas insertables (se excluyen identidades y columnas generadas). */
async function insertableColumns(table: string): Promise<string[]> {
  const [schema, name] = table.split('.');
  const { rows } = await pools.superuser.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND is_identity = 'NO' AND is_generated = 'NEVER' ORDER BY ordinal_position`,
    [schema, name],
  );
  return rows.map((r) => `"${r.column_name}"`);
}

describe('aislamiento entre negocios — cobertura', () => {
  it('descubre las tablas de negocio de la Fase 0 y todas tienen datos de prueba en A y en B', async () => {
    expect(tables).toEqual(
      expect.arrayContaining([
        'audit.audit_log', 'core.branches', 'core.employee_branch_assignments', 'core.employees', 'core.kiosk_devices',
        'core.invitations', 'core.kiosk_pairing_codes', 'core.organization_memberships', 'core.pin_attempts', 'core.policy_overrides',
        'core.role_assignment_branches', 'core.role_assignments', 'core.role_permissions', 'core.roles',
        'scheduling.schedule_template_entries', 'scheduling.schedule_templates', 'scheduling.shifts', 'scheduling.weekly_schedules',
        'attendance.breaks', 'attendance.correction_requests', 'attendance.corrections', 'attendance.events', 'attendance.incidents', 'attendance.work_sessions',
      ]),
    );
    for (const t of tables) {
      for (const org of [A, B]) {
        // si se agrega una tabla nueva sin datos de siembra, esta prueba obliga a sembrarla (no hay aislamiento "vacío")
        expect(await count(pools.platform, `SELECT count(*) FROM ${t} WHERE organization_id = $1`, [org.organizationId]), `${t} sin filas de prueba`).toBeGreaterThan(0);
      }
    }
  });
});

describe('aislamiento negocio A ↔ negocio B — LECTURA y ESCRITURA en cada tabla', () => {
  it.each(['audit.audit_log', 'core.branches', 'core.employee_branch_assignments', 'core.employees', 'core.invitations', 'core.kiosk_devices',
    'core.kiosk_pairing_codes', 'core.organization_memberships', 'core.pin_attempts', 'core.policy_overrides',
    'core.role_assignment_branches', 'core.role_assignments', 'core.role_permissions', 'core.roles',
    'scheduling.schedule_template_entries', 'scheduling.schedule_templates', 'scheduling.shifts', 'scheduling.weekly_schedules',
    'attendance.breaks', 'attendance.correction_requests', 'attendance.corrections', 'attendance.events', 'attendance.incidents', 'attendance.work_sessions'])('%s', async (table) => {
    expect(tables).toContain(table);
    const totalA = await count(pools.platform, `SELECT count(*) FROM ${table} WHERE organization_id = $1`, [A.organizationId]);
    const columns = await insertableColumns(table);
    const rowOfB = (await pools.platform.query(`SELECT to_jsonb(t) AS j FROM ${table} t WHERE organization_id = $1 LIMIT 1`, [B.organizationId])).rows[0].j;

    // ── Lectura ────────────────────────────────────────────────────────────────
    await asTenant(pools.app, A.organizationId, async (c) => {
      expect(await count(c, `SELECT count(*) FROM ${table} WHERE organization_id = $1`, [B.organizationId]), 've filas de B').toBe(0);
      expect(await count(c, `SELECT count(*) FROM ${table}`), 've solo lo de A').toBe(totalA);
    });
    await asTenant(pools.app, B.organizationId, async (c) => {
      expect(await count(c, `SELECT count(*) FROM ${table} WHERE organization_id = $1`, [A.organizationId])).toBe(0);
    });
    // Sin contexto de negocio: falla cerrado
    await asTenant(pools.app, null, async (c) => {
      expect(await count(c, `SELECT count(*) FROM ${table}`), 'sin contexto debe ver 0 filas').toBe(0);
    });

    // ── Escritura con el contexto de A sobre datos de B ────────────────────────
    await asTenant(pools.app, A.organizationId, async (c) => {
      // UPDATE / DELETE de filas de B: 0 filas afectadas o privilegio denegado (nunca modifica a B)
      for (const sql of [`UPDATE ${table} SET organization_id = organization_id WHERE organization_id = $1`, `DELETE FROM ${table} WHERE organization_id = $1`]) {
        const err = await pgError(c, sql, [B.organizationId]);
        if (err === null) {
          const r = await c.query(sql, [B.organizationId]);
          expect(r.rowCount, sql).toBe(0);
        } else {
          expect(err.code, `${sql} → ${err.message}`).toBe('42501');
        }
      }
      // INSERT de una fila que pertenece a B estando en el contexto de A ⇒ viola la política RLS
      const insert = await pgError(
        c,
        `INSERT INTO ${table} (${columns.join(', ')}) SELECT ${columns.join(', ')} FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`,
        [JSON.stringify(rowOfB)],
      );
      expect(insert?.code, `INSERT cruzado en ${table}: ${insert?.message}`).toBe('42501');
      // Mover una fila propia al negocio B ⇒ rechazado por WITH CHECK (o sin privilegio de UPDATE)
      const move = await pgError(c, `UPDATE ${table} SET organization_id = $1 WHERE organization_id = $2`, [B.organizationId, A.organizationId]);
      expect(move?.code, `mover filas a B en ${table}: ${move?.message}`).toBe('42501');
    });

    // B quedó intacto
    expect(await count(pools.platform, `SELECT count(*) FROM ${table} WHERE organization_id = $1`, [B.organizationId])).toBeGreaterThan(0);
  });
});

describe('aislamiento — tablas especiales', () => {
  it('core.organizations: cada negocio ve solo su fila y no puede editar otro ni crear negocios', async () => {
    await asTenant(pools.app, A.organizationId, async (c) => {
      const { rows } = await c.query('SELECT id FROM core.organizations');
      expect(rows.map((r) => r.id)).toEqual([A.organizationId]);
      const r = await c.query(`UPDATE core.organizations SET name = 'hack' WHERE id = $1`, [B.organizationId]);
      expect(r.rowCount).toBe(0);
    });
    await asTenant(pools.app, null, async (c) => expect(await count(c, 'SELECT count(*) FROM core.organizations')).toBe(0));
  });

  it('auth.users: un negocio solo ve a sus miembros (y a sí mismo), nunca a los de otro negocio', async () => {
    await asTenant(pools.app, A.organizationId, async (c) => {
      const emails = (await c.query('SELECT email FROM auth.users')).rows.map((r) => r.email);
      expect(emails).toContain(A.adminEmail);
      expect(emails).not.toContain(B.adminEmail);
    });
    await asTenant(pools.app, null, async (c) => expect(await count(c, 'SELECT count(*) FROM auth.users')).toBe(0));
  });

  it('core.organization_memberships: el usuario autenticado puede listar SUS membresías, pero no las ajenas', async () => {
    await asTenant(pools.app, null, async (c) => {
      const rows = (await c.query('SELECT organization_id FROM core.organization_memberships')).rows;
      expect(rows).toEqual([]);
    });
    await asTenant(pools.app, null, async (c) => {
      const rows = (await c.query('SELECT organization_id FROM core.organization_memberships')).rows.map((r) => r.organization_id);
      expect(rows).toEqual([A.organizationId]);
    }, A.adminUserId);
    // …pero con un negocio ya seleccionado solo rige el aislamiento por negocio: nada de membresías del mismo usuario en otros negocios
    await world.platformAdmin.createOrganization({
      name: 'Otro de A', slug: 'iso-a-otro', timezone: 'America/Tijuana', admin: { email: A.adminEmail, displayName: 'Mismo dueño' },
    });
    await asTenant(pools.app, A.organizationId, async (c) => {
      const rows = (await c.query('SELECT organization_id FROM core.organization_memberships')).rows.map((r) => r.organization_id);
      expect(new Set(rows)).toEqual(new Set([A.organizationId]));
    }, A.adminUserId);
  });

  it('el contexto de una transacción no se filtra a la siguiente petición del mismo pool (set_config local)', async () => {
    const pool1 = new (await import('pg')).default.Pool({ connectionString: pools.app.options.connectionString, max: 1 });
    try {
      await asTenant(pool1, A.organizationId, async (c) => expect(await count(c, 'SELECT count(*) FROM core.employees')).toBeGreaterThan(0));
      const { rows } = await pool1.query(`SELECT nullif(current_setting('app.organization_id', true), '') AS org`);
      expect(rows[0].org).toBeNull();
      expect(await count(pool1, 'SELECT count(*) FROM core.employees')).toBe(0);
    } finally {
      await pool1.end();
    }
  });
});

describe('aislamiento — integridad referencial entre negocios (FKs compuestas)', () => {
  const insertAs = async (sql: string, params: unknown[]) => {
    const c = await pools.platform.connect(); // platform_ops (BYPASSRLS): RLS no interviene, solo las FKs
    try {
      await c.query('BEGIN');
      return await pgError(c, sql, params);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  };

  it('una asignación no puede mezclar empleado de A con sucursal de B', async () => {
    const err = await insertAs(
      `INSERT INTO core.employee_branch_assignments (organization_id, employee_id, branch_id, kind, valid_from) VALUES ($1, $2, $3, 'TEMPORARY', '2031-01-01')`,
      [A.organizationId, A.employeeId, B.branchA],
    );
    expect(err?.code).toBe('23503');
  });

  it('el alcance de un rol no puede apuntar a una sucursal de otro negocio', async () => {
    const assignment = (await pools.platform.query(`SELECT id FROM core.role_assignments WHERE organization_id = $1 AND scope = 'BRANCHES' LIMIT 1`, [A.organizationId])).rows[0].id;
    const err = await insertAs(`INSERT INTO core.role_assignment_branches (organization_id, assignment_id, branch_id) VALUES ($1, $2, $3)`, [A.organizationId, assignment, B.branchA]);
    expect(err?.code).toBe('23503');
  });

  it('un kiosco, una política o una membresía no pueden referenciar datos de otro negocio', async () => {
    expect((await insertAs(
      `INSERT INTO core.kiosk_devices (organization_id, branch_id, name, token_prefix, token_hash, token_issued_at) VALUES ($1, $2, 'x', 'abcdefghijkl', repeat('a', 64), now())`,
      [A.organizationId, B.branchA]))?.code).toBe('23503');
    expect((await insertAs(
      `INSERT INTO core.policy_overrides (organization_id, scope, employee_id, break_allowed_min) VALUES ($1, 'EMPLOYEE', $2, 20)`,
      [A.organizationId, B.employeeId]))?.code).toBe('23503');
    expect((await insertAs(
      `WITH u AS (INSERT INTO auth.users (email, display_name) VALUES ('fk-test-' || gen_random_uuid() || '@ejemplo.com', 'FK') RETURNING id)
       INSERT INTO core.organization_memberships (organization_id, user_id, employee_id) SELECT $1, id, $2 FROM u`,
      [A.organizationId, B.employeeId]))?.code).toBe('23503');
    expect((await insertAs(
      `INSERT INTO audit.audit_log (organization_id, branch_id, actor_type, action, entity_type) VALUES ($1, $2, 'SYSTEM', 'x.y', 'x')`,
      [A.organizationId, B.branchA]))?.code).toBe('23503');
  });
});

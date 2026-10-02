import { afterAll, describe, expect, it } from 'vitest';
import { asTenant, pgError } from './helpers/sql.js';
import { buildWorld, openPools, seedOrganization } from './helpers/world.js';

const pools = openPools();
afterAll(() => pools.close());

describe('roles de PostgreSQL', () => {
  it('app_user y migrator NO son superusuario ni tienen BYPASSRLS; platform_ops y gate_owner sí lo tienen', async () => {
    const { rows } = await pools.superuser.query(
      `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN ('app_user','migrator','platform_ops','gate_owner')`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.rolname, r]));
    expect(by.app_user).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcanlogin: true });
    expect(by.migrator).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcanlogin: true });
    expect(by.platform_ops).toMatchObject({ rolsuper: false, rolbypassrls: true, rolcanlogin: true });
    expect(by.gate_owner).toMatchObject({ rolsuper: false, rolbypassrls: true, rolcanlogin: false });
  });

  it('la conexión real de la API se comporta como app_user sin BYPASSRLS', async () => {
    const { rows } = await pools.app.query(`SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super`);
    expect(rows[0]).toMatchObject({ current_user: 'app_user', bypass: false, super: false });
  });

  it('app_user no puede borrar datos de negocio ni modificar la auditoría', async () => {
    await asTenant(pools.app, null, async (c) => {
      for (const t of ['core.employees', 'core.branches', 'core.organization_memberships', 'core.kiosk_devices', 'core.policy_overrides', 'core.employee_branch_assignments']) {
        expect((await pgError(c, `DELETE FROM ${t}`))?.code, `DELETE en ${t}`).toBe('42501');
      }
      expect((await pgError(c, 'UPDATE audit.audit_log SET reason = $1', ['x']))?.code).toBe('42501');
      expect((await pgError(c, 'DELETE FROM audit.audit_log'))?.code).toBe('42501');
      expect((await pgError(c, 'TRUNCATE audit.audit_log'))?.code).toBe('42501');
    });
  });

  it('app_user no puede crear negocios ni tocar el catálogo de permisos ni la política de plataforma', async () => {
    await asTenant(pools.app, null, async (c) => {
      expect((await pgError(c, `INSERT INTO core.organizations (slug, name, timezone) VALUES ('x','x','UTC')`))?.code).toBe('42501');
      expect((await pgError(c, `INSERT INTO core.permissions (code, description) VALUES ('x.y','z')`))?.code).toBe('42501');
      expect((await pgError(c, `UPDATE platform.policy_defaults SET break_allowed_min = 1`))?.code).toBe('42501');
      expect((await pgError(c, `SELECT * FROM platform.platform_audit_log`))?.code).toBe('42501');
    });
  });

  it('platform_ops tampoco puede borrar ni alterar las bitácoras (privilegios + trigger solo-agregar)', async () => {
    const c = await pools.platform.connect();
    try {
      await c.query('BEGIN');
      for (const [sql, params] of [
        ['UPDATE audit.audit_log SET reason = $1', ['x']],
        ['DELETE FROM audit.audit_log', []],
        ['UPDATE platform.platform_audit_log SET actor = $1', ['x']],
        ['DELETE FROM platform.platform_audit_log', []],
      ] as const) {
        const err = await pgError(c, sql, [...params]);
        expect(err?.code ?? 'sin-error', sql).toMatch(/^(42501|23001)$/);
      }
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('el trigger solo-agregar frena incluso al dueño de la tabla (migrator) cuando ve filas', async () => {
    const org = await seedOrganization(buildWorld(pools));
    const c = await pools.migrator.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.organization_id', $1, true)`, [org.organizationId]); // el dueño también está sujeto a RLS (FORCE)
      expect(Number((await c.query('SELECT count(*) FROM audit.audit_log')).rows[0].count)).toBeGreaterThan(0);
      for (const sql of ['DELETE FROM audit.audit_log', `UPDATE audit.audit_log SET reason = 'x'`, 'TRUNCATE audit.audit_log']) {
        const err = await pgError(c, sql);
        expect(err?.code, sql).toBe('23001'); // restrict_violation lanzada por el trigger
      }
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});

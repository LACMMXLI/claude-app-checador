-- 0001 · Fundaciones: extensiones, esquemas, privilegios por defecto y funciones base.
-- Se ejecuta como `migrator` (dueño de los objetos). Los roles los crea el bootstrap (superusuario).

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS audit;

GRANT USAGE ON SCHEMA platform, auth, core, audit TO app_user, platform_ops;
GRANT USAGE, CREATE ON SCHEMA auth, core, audit TO gate_owner;   -- CREATE: requerido para ALTER FUNCTION ... OWNER TO gate_owner

-- app_user: SELECT/INSERT/UPDATE (nunca DELETE) en core y audit. auth/platform: privilegios explícitos por tabla.
ALTER DEFAULT PRIVILEGES IN SCHEMA core, audit GRANT SELECT, INSERT, UPDATE ON TABLES TO app_user;
-- platform_ops (BYPASSRLS): SELECT/INSERT/UPDATE en todo; tampoco DELETE.
ALTER DEFAULT PRIVILEGES IN SCHEMA platform, auth, core, audit GRANT SELECT, INSERT, UPDATE ON TABLES TO platform_ops;

-- ── Contexto de negocio ─────────────────────────────────────────────────────────
-- Sin valor => NULL => ninguna fila coincide (falla cerrado).
CREATE FUNCTION core.current_org() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.organization_id', true), '')::uuid $$;

CREATE FUNCTION core.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- ── Triggers genéricos ──────────────────────────────────────────────────────────
CREATE FUNCTION core.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE FUNCTION core.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'La tabla %.% es solo-agregar (% prohibido)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- Zona horaria IANA válida (existe en pg_timezone_names y es "Region/Ciudad" o UTC)
CREATE FUNCTION core.assert_valid_timezone() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.timezone IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_timezone_names z
       WHERE z.name = NEW.timezone AND (z.name LIKE '%/%' OR z.name = 'UTC')) THEN
    RAISE EXCEPTION 'Zona horaria inválida: %', NEW.timezone USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN NEW;
END
$$;

-- ── Registro de excepciones al aislamiento por organization_id ─────────────────
CREATE TABLE core.tenant_exempt_tables (
  table_schema text NOT NULL,
  table_name   text NOT NULL,
  reason       text NOT NULL,
  PRIMARY KEY (table_schema, table_name)
);
INSERT INTO core.tenant_exempt_tables (table_schema, table_name, reason) VALUES
  ('core',     'tenant_exempt_tables', 'registro de excepciones (solo lectura para app_user)'),
  ('core',     'permissions',          'catálogo global de permisos, sin datos de negocio'),
  ('core',     'organizations',        'es el tenant; política propia: id = core.current_org()'),
  ('auth',     'users',                'identidad global; política propia: visible solo si es miembro del negocio activo o es la sesión'),
  ('auth',     'user_credentials',     'credenciales globales; app_user sin privilegios (solo funciones-puerta)'),
  ('platform', 'policy_defaults',      'política de nivel plataforma (singleton); app_user solo SELECT'),
  ('platform', 'platform_audit_log',   'bitácora de plataforma; app_user sin privilegios'),
  ('public',   'schema_migrations',    'control de migraciones');
REVOKE INSERT, UPDATE ON core.tenant_exempt_tables FROM app_user;

-- ── Helper: protege una tabla de negocio (RLS habilitado + forzado + política) ─
CREATE FUNCTION core.enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS
$$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (organization_id = core.current_org()) WITH CHECK (organization_id = core.current_org())',
    tbl);
END
$$;

-- ── Verificación de catálogo: lo usa CI (pnpm check:tenancy) ───────────────────
-- Devuelve una fila por violación. Vacío = todo protegido.
CREATE FUNCTION core.tenant_isolation_violations()
RETURNS TABLE (table_name text, problem text)
LANGUAGE sql STABLE AS
$$
  WITH t AS (
    SELECT c.oid, n.nspname AS sch, c.relname AS rel, c.relrowsecurity AS rls, c.relforcerowsecurity AS frls,
           EXISTS (SELECT 1 FROM core.tenant_exempt_tables e
                   WHERE e.table_schema = n.nspname AND e.table_name = c.relname) AS exempt,
           (SELECT a.attnotnull FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped) AS org_notnull
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('information_schema')
      AND n.nspname !~ '^pg_'
  )
  SELECT sch || '.' || rel, 'falta la columna organization_id (y no está en core.tenant_exempt_tables)'
    FROM t WHERE NOT exempt AND org_notnull IS NULL
  UNION ALL
  SELECT sch || '.' || rel, 'organization_id admite NULL'
    FROM t WHERE NOT exempt AND org_notnull IS NOT NULL AND NOT org_notnull
  UNION ALL
  SELECT sch || '.' || rel, 'RLS no habilitado'
    FROM t WHERE NOT exempt AND org_notnull IS NOT NULL AND NOT rls
  UNION ALL
  SELECT sch || '.' || rel, 'RLS no forzado (FORCE ROW LEVEL SECURITY)'
    FROM t WHERE NOT exempt AND org_notnull IS NOT NULL AND NOT frls
  UNION ALL
  SELECT sch || '.' || rel, 'sin política que use core.current_org() en USING y WITH CHECK para todas las operaciones'
    FROM t WHERE NOT exempt AND org_notnull IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = t.oid AND p.polpermissive AND p.polcmd = '*'
        AND pg_get_expr(p.polqual, p.polrelid)      LIKE '%current_org()%'
        AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%current_org()%')
  UNION ALL
  -- Invariante de tiempo: nada de timestamp sin zona horaria (todo es timestamptz/UTC)
  SELECT t.sch || '.' || t.rel || '.' || a.attname, 'columna timestamp WITHOUT time zone (usar timestamptz)'
    FROM t JOIN pg_attribute a ON a.attrelid = t.oid
   WHERE a.attnum > 0 AND NOT a.attisdropped AND a.atttypid = 'timestamp'::regtype
$$;

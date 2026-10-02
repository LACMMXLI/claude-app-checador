-- 0002 · Negocios, sucursales, empleados y asignaciones.

-- ── organizations (el tenant) ───────────────────────────────────────────────────
CREATE TABLE core.organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  timezone   text NOT NULL,                       -- OBLIGATORIA, sin default (D-1)
  branding   jsonb NOT NULL DEFAULT '{}'::jsonb,
  status     text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER organizations_tz BEFORE INSERT OR UPDATE OF timezone ON core.organizations
  FOR EACH ROW EXECUTE FUNCTION core.assert_valid_timezone();
CREATE TRIGGER organizations_updated BEFORE UPDATE ON core.organizations
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE core.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY own_organization ON core.organizations
  USING (id = core.current_org()) WITH CHECK (id = core.current_org());
-- app_user: solo ve su negocio y edita nombre, marca y zona; crear negocios es de platform_ops
REVOKE INSERT, UPDATE ON core.organizations FROM app_user;
GRANT UPDATE (name, branding, timezone) ON core.organizations TO app_user;

-- ── branches ───────────────────────────────────────────────────────────────────
CREATE TABLE core.branches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  code            text NOT NULL CHECK (code ~ '^[A-Za-z0-9_-]{1,32}$'),
  name            text NOT NULL CHECK (length(btrim(name)) > 0),
  timezone        text,                            -- NULL = hereda la del negocio
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code)
);
CREATE TRIGGER branches_tz BEFORE INSERT OR UPDATE OF timezone ON core.branches
  FOR EACH ROW EXECUTE FUNCTION core.assert_valid_timezone();
CREATE TRIGGER branches_updated BEFORE UPDATE ON core.branches
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT core.enable_tenant_rls('core.branches');

-- ── employees ──────────────────────────────────────────────────────────────────
CREATE TABLE core.employees (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES core.organizations (id),
  employee_number    text NOT NULL CHECK (length(btrim(employee_number)) > 0),
  first_name         text NOT NULL CHECK (length(btrim(first_name)) > 0),
  last_name          text NOT NULL DEFAULT '',
  phone              text,
  notes              text,
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  hired_at           date,
  terminated_at      date,
  termination_reason text,
  pin_hash           text,                         -- HMAC-SHA256(pepper, org ‖ pin). NUNCA el PIN.
  pin_set_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, employee_number),
  CHECK (status = 'ACTIVE' OR pin_hash IS NULL),   -- la baja invalida el PIN
  CHECK (pin_hash IS NULL OR pin_hash ~ '^[0-9a-f]{64}$')
);
-- PIN único entre ACTIVOS del mismo negocio. El mismo PIN en otro negocio es válido.
CREATE UNIQUE INDEX employees_pin_unique ON core.employees (organization_id, pin_hash)
  WHERE status = 'ACTIVE' AND pin_hash IS NOT NULL;
CREATE TRIGGER employees_updated BEFORE UPDATE ON core.employees
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT core.enable_tenant_rls('core.employees');

-- ── employee_branch_assignments ────────────────────────────────────────────────
CREATE TABLE core.employee_branch_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  employee_id     uuid NOT NULL,
  branch_id       uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('PRIMARY', 'TEMPORARY')),
  valid_from      date NOT NULL,
  valid_to        date,
  reason          text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, employee_id) REFERENCES core.employees (organization_id, id),
  FOREIGN KEY (organization_id, branch_id)   REFERENCES core.branches  (organization_id, id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  -- Solo una asignación PRIMARY vigente a la vez por empleado
  CONSTRAINT one_primary_at_a_time EXCLUDE USING gist (
    employee_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&) WHERE (kind = 'PRIMARY')
);
CREATE INDEX assignments_by_branch ON core.employee_branch_assignments (organization_id, branch_id, valid_from);
CREATE INDEX assignments_by_employee ON core.employee_branch_assignments (organization_id, employee_id, valid_from);
CREATE TRIGGER assignments_updated BEFORE UPDATE ON core.employee_branch_assignments
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT core.enable_tenant_rls('core.employee_branch_assignments');

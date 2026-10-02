-- 0004 · Kioscos, intentos de PIN, políticas (jerarquía D-20) y auditoría.

-- ── Kioscos: el token pertenece a organization_id + branch_id + device_id ──────
CREATE TABLE core.kiosk_devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- = device_id
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  branch_id       uuid NOT NULL,
  name            text NOT NULL CHECK (length(btrim(name)) > 0),
  token_prefix    text NOT NULL UNIQUE CHECK (token_prefix ~ '^[A-Za-z0-9]{12}$'),   -- identificador público
  token_hash      text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),               -- SHA-256 del secreto; nunca el token
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  last_seen_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, branch_id) REFERENCES core.branches (organization_id, id),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE TRIGGER kiosk_devices_updated BEFORE UPDATE ON core.kiosk_devices
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT core.enable_tenant_rls('core.kiosk_devices');

CREATE TABLE core.kiosk_pairing_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  branch_id       uuid NOT NULL,
  code_hash       text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, branch_id) REFERENCES core.branches (organization_id, id)
);
SELECT core.enable_tenant_rls('core.kiosk_pairing_codes');

-- ── Intentos de PIN por kiosco (no guarda el PIN intentado) ────────────────────
CREATE TABLE core.pin_attempts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  device_id       uuid NOT NULL,
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  success         boolean NOT NULL,
  employee_id     uuid,
  FOREIGN KEY (organization_id, device_id)   REFERENCES core.kiosk_devices (organization_id, id),
  FOREIGN KEY (organization_id, employee_id) REFERENCES core.employees (organization_id, id),
  CHECK (success = (employee_id IS NOT NULL))
);
CREATE INDEX pin_attempts_by_device ON core.pin_attempts (organization_id, device_id, attempted_at DESC);
SELECT core.enable_tenant_rls('core.pin_attempts');

-- ── Política de plataforma (singleton, completa) ───────────────────────────────
CREATE TABLE platform.policy_defaults (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  entry_tolerance_min    integer NOT NULL DEFAULT 10   CHECK (entry_tolerance_min    BETWEEN 0 AND 240),
  exit_tolerance_min     integer NOT NULL DEFAULT 0    CHECK (exit_tolerance_min     BETWEEN 0 AND 240),
  max_breaks             integer NOT NULL DEFAULT 1    CHECK (max_breaks             BETWEEN 0 AND 10),
  break_allowed_min      integer NOT NULL DEFAULT 35   CHECK (break_allowed_min      BETWEEN 0 AND 600),
  break_tolerance_min    integer NOT NULL DEFAULT 0    CHECK (break_tolerance_min    BETWEEN 0 AND 120),
  require_break          boolean NOT NULL DEFAULT false,
  early_entry_window_min integer NOT NULL DEFAULT 60   CHECK (early_entry_window_min BETWEEN 0 AND 720),
  absent_after_min       integer NOT NULL DEFAULT 60   CHECK (absent_after_min       BETWEEN 1 AND 720),
  operational_cutoff     time    NOT NULL DEFAULT '05:00',
  max_hours_unscheduled  integer NOT NULL DEFAULT 14   CHECK (max_hours_unscheduled  BETWEEN 1 AND 48),
  debounce_sec           integer NOT NULL DEFAULT 60   CHECK (debounce_sec           BETWEEN 0 AND 3600),
  pin_max_attempts       integer NOT NULL DEFAULT 5    CHECK (pin_max_attempts       BETWEEN 1 AND 20),
  pin_lockout_sec        integer NOT NULL DEFAULT 60   CHECK (pin_lockout_sec        BETWEEN 1 AND 3600),
  week_start_day         integer NOT NULL DEFAULT 1    CHECK (week_start_day         BETWEEN 1 AND 7),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform.policy_defaults (id) VALUES (true);
GRANT SELECT ON platform.policy_defaults TO app_user;

-- ── Overrides por nivel: Negocio → Sucursal → Empleado (NULL = hereda) ─────────
CREATE TABLE core.policy_overrides (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES core.organizations (id),
  scope                  text NOT NULL CHECK (scope IN ('ORGANIZATION', 'BRANCH', 'EMPLOYEE')),
  branch_id              uuid,
  employee_id            uuid,
  entry_tolerance_min    integer CHECK (entry_tolerance_min    BETWEEN 0 AND 240),
  exit_tolerance_min     integer CHECK (exit_tolerance_min     BETWEEN 0 AND 240),
  max_breaks             integer CHECK (max_breaks             BETWEEN 0 AND 10),
  break_allowed_min      integer CHECK (break_allowed_min      BETWEEN 0 AND 600),
  break_tolerance_min    integer CHECK (break_tolerance_min    BETWEEN 0 AND 120),
  require_break          boolean,
  early_entry_window_min integer CHECK (early_entry_window_min BETWEEN 0 AND 720),
  absent_after_min       integer CHECK (absent_after_min       BETWEEN 1 AND 720),
  operational_cutoff     time,
  max_hours_unscheduled  integer CHECK (max_hours_unscheduled  BETWEEN 1 AND 48),
  debounce_sec           integer CHECK (debounce_sec           BETWEEN 0 AND 3600),
  pin_max_attempts       integer CHECK (pin_max_attempts       BETWEEN 1 AND 20),
  pin_lockout_sec        integer CHECK (pin_lockout_sec        BETWEEN 1 AND 3600),
  week_start_day         integer CHECK (week_start_day         BETWEEN 1 AND 7),
  updated_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, branch_id)   REFERENCES core.branches  (organization_id, id),
  FOREIGN KEY (organization_id, employee_id) REFERENCES core.employees (organization_id, id),
  -- coherencia nivel ↔ destino
  CONSTRAINT scope_target CHECK (
       (scope = 'ORGANIZATION' AND branch_id IS NULL     AND employee_id IS NULL)
    OR (scope = 'BRANCH'       AND branch_id IS NOT NULL AND employee_id IS NULL)
    OR (scope = 'EMPLOYEE'     AND employee_id IS NOT NULL AND branch_id IS NULL)),
  -- hasta qué nivel puede sobrescribirse cada parámetro
  CONSTRAINT employee_scope_params CHECK (scope <> 'EMPLOYEE' OR (
        early_entry_window_min IS NULL AND absent_after_min IS NULL AND operational_cutoff IS NULL
    AND max_hours_unscheduled IS NULL AND debounce_sec IS NULL AND pin_max_attempts IS NULL
    AND pin_lockout_sec IS NULL AND week_start_day IS NULL)),
  CONSTRAINT organization_only_params CHECK (scope = 'ORGANIZATION' OR week_start_day IS NULL)
);
CREATE UNIQUE INDEX policy_org_unique ON core.policy_overrides (organization_id) WHERE scope = 'ORGANIZATION';
CREATE UNIQUE INDEX policy_branch_unique ON core.policy_overrides (organization_id, branch_id) WHERE scope = 'BRANCH';
CREATE UNIQUE INDEX policy_employee_unique ON core.policy_overrides (organization_id, employee_id) WHERE scope = 'EMPLOYEE';
CREATE TRIGGER policy_overrides_updated BEFORE UPDATE ON core.policy_overrides
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT core.enable_tenant_rls('core.policy_overrides');

-- ── Auditoría por negocio (solo-agregar) ───────────────────────────────────────
CREATE TABLE audit.audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  branch_id       uuid,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_type      text NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM', 'KIOSK')),
  actor_user_id   uuid,
  actor_device_id uuid,
  action          text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  entity_type     text NOT NULL,
  entity_id       text,
  before          jsonb,
  after           jsonb,
  reason          text,
  ip              text,
  request_id      text,
  FOREIGN KEY (organization_id, branch_id) REFERENCES core.branches (organization_id, id)
);
CREATE INDEX audit_by_time   ON audit.audit_log (organization_id, occurred_at DESC);
CREATE INDEX audit_by_entity ON audit.audit_log (organization_id, entity_type, entity_id);
CREATE INDEX audit_by_branch ON audit.audit_log (organization_id, branch_id, occurred_at DESC);
CREATE INDEX audit_by_actor  ON audit.audit_log (organization_id, actor_user_id, occurred_at DESC);
SELECT core.enable_tenant_rls('audit.audit_log');
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION core.forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION core.forbid_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON audit.audit_log FROM app_user, platform_ops;

-- ── Bitácora de plataforma (solo-agregar; app_user sin acceso) ─────────────────
CREATE TABLE platform.platform_audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor           text NOT NULL,
  action          text NOT NULL,
  organization_id uuid,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TRIGGER platform_audit_immutable BEFORE UPDATE OR DELETE ON platform.platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION core.forbid_mutation();
CREATE TRIGGER platform_audit_no_truncate BEFORE TRUNCATE ON platform.platform_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION core.forbid_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON platform.platform_audit_log FROM platform_ops;

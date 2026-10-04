-- 0013 · Fase 5: plataforma de suscripciones (D-81…D-90).
-- Planes, suscripciones por negocio (sin cobros), historial inmutable, operadores de plataforma y límites del plan
-- aplicados también en PostgreSQL. Todo vive en el esquema `platform`: app_user NO tiene privilegios sobre estas tablas;
-- el negocio solo ve su propio plan a través de la función-puerta core.current_entitlements().

-- ── Planes ─────────────────────────────────────────────────────────────────────
CREATE TABLE platform.plans (
  code          text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  name          text NOT NULL CHECK (length(btrim(name)) > 0),
  description   text NOT NULL DEFAULT '',
  -- NULL = sin límite
  max_branches  integer CHECK (max_branches  IS NULL OR max_branches  >= 1),
  max_employees integer CHECK (max_employees IS NULL OR max_employees >= 1),
  max_kiosks    integer CHECK (max_kiosks    IS NULL OR max_kiosks    >= 1),
  max_members   integer CHECK (max_members   IS NULL OR max_members   >= 1),
  features      jsonb   NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(features) = 'object'),
  sort_order    integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER plans_updated BEFORE UPDATE ON platform.plans
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

INSERT INTO platform.plans (code, name, description, max_branches, max_employees, max_kiosks, max_members, features, sort_order) VALUES
  ('BASIC',    'Básico',   'Para un negocio pequeño: lo esencial para checar y revisar asistencia.',
     2,  25,  2,  3, '{"reportsExport": false, "scheduleTemplates": false}', 1),
  ('ADVANCED', 'Avanzado', 'Más sucursales, más personal y todas las funciones.',
    10, 250, 20, 25, '{"reportsExport": true,  "scheduleTemplates": true}',  2);

-- ── Suscripción vigente de cada negocio ────────────────────────────────────────
CREATE TABLE platform.subscriptions (
  organization_id    uuid PRIMARY KEY REFERENCES core.organizations (id),
  plan_code          text NOT NULL REFERENCES platform.plans (code),
  status             text NOT NULL CHECK (status IN ('TRIAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED')),
  trial_ends_at      timestamptz,
  current_period_end timestamptz,                       -- NULL = sin vencimiento (vigencia manual, sin cobros)
  notes              text NOT NULL DEFAULT '',          -- internas: nunca salen de la plataforma
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'TRIAL' OR trial_ends_at IS NOT NULL)
);
CREATE INDEX subscriptions_status_idx ON platform.subscriptions (status);
CREATE TRIGGER subscriptions_updated BEFORE UPDATE ON platform.subscriptions
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- TRIAL y ACTIVE dejan operar al negocio; cualquier otro estado lo suspende (no se borra nada).
CREATE FUNCTION platform.sync_organization_status() RETURNS trigger
LANGUAGE plpgsql AS
$$
DECLARE
  v_status text := CASE WHEN NEW.status IN ('TRIAL', 'ACTIVE') THEN 'ACTIVE' ELSE 'SUSPENDED' END;
BEGIN
  UPDATE core.organizations SET status = v_status WHERE id = NEW.organization_id AND status <> v_status;
  RETURN NEW;
END
$$;
CREATE TRIGGER subscriptions_sync_org AFTER INSERT OR UPDATE OF status ON platform.subscriptions
  FOR EACH ROW EXECUTE FUNCTION platform.sync_organization_status();

-- ── Historial de la suscripción (solo-agregar; lo escribe un trigger) ──────────
CREATE TABLE platform.subscription_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  actor           text NOT NULL,
  event           text NOT NULL CHECK (event IN ('CREATED', 'PLAN_CHANGED', 'STATUS_CHANGED', 'PERIOD_CHANGED', 'NOTES_CHANGED')),
  from_plan       text,
  to_plan         text,
  from_status     text,
  to_status       text,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX subscription_events_org_idx ON platform.subscription_events (organization_id, id DESC);
CREATE TRIGGER subscription_events_immutable BEFORE UPDATE OR DELETE ON platform.subscription_events
  FOR EACH ROW EXECUTE FUNCTION core.forbid_mutation();
CREATE TRIGGER subscription_events_no_truncate BEFORE TRUNCATE ON platform.subscription_events
  FOR EACH STATEMENT EXECUTE FUNCTION core.forbid_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON platform.subscription_events FROM platform_ops;

CREATE FUNCTION platform.log_subscription_event() RETURNS trigger
LANGUAGE plpgsql AS
$$
DECLARE
  v_actor text := coalesce(nullif(current_setting('app.platform_actor', true), ''), 'system');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO platform.subscription_events (organization_id, actor, event, to_plan, to_status, details)
    VALUES (NEW.organization_id, v_actor, 'CREATED', NEW.plan_code, NEW.status,
            jsonb_build_object('trialEndsAt', NEW.trial_ends_at, 'currentPeriodEnd', NEW.current_period_end));
    RETURN NEW;
  END IF;
  IF NEW.plan_code IS DISTINCT FROM OLD.plan_code THEN
    INSERT INTO platform.subscription_events (organization_id, actor, event, from_plan, to_plan)
    VALUES (NEW.organization_id, v_actor, 'PLAN_CHANGED', OLD.plan_code, NEW.plan_code);
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO platform.subscription_events (organization_id, actor, event, from_status, to_status)
    VALUES (NEW.organization_id, v_actor, 'STATUS_CHANGED', OLD.status, NEW.status);
  END IF;
  IF NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at OR NEW.current_period_end IS DISTINCT FROM OLD.current_period_end THEN
    INSERT INTO platform.subscription_events (organization_id, actor, event, details)
    VALUES (NEW.organization_id, v_actor, 'PERIOD_CHANGED',
            jsonb_build_object('trialEndsAt', jsonb_build_object('from', OLD.trial_ends_at, 'to', NEW.trial_ends_at),
                               'currentPeriodEnd', jsonb_build_object('from', OLD.current_period_end, 'to', NEW.current_period_end)));
  END IF;
  IF NEW.notes IS DISTINCT FROM OLD.notes THEN
    INSERT INTO platform.subscription_events (organization_id, actor, event) VALUES (NEW.organization_id, v_actor, 'NOTES_CHANGED');
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER subscriptions_log AFTER INSERT OR UPDATE ON platform.subscriptions
  FOR EACH ROW EXECUTE FUNCTION platform.log_subscription_event();

-- ── Compatibilidad (D-89): negocios existentes → ADVANCED/ACTIVE (respetando los ya suspendidos) ──
-- Los triggers de arriba ya existen: el relleno queda en el historial (actor "system") y el estado del negocio queda coherente.
INSERT INTO platform.subscriptions (organization_id, plan_code, status)
SELECT o.id, 'ADVANCED', CASE o.status WHEN 'ACTIVE' THEN 'ACTIVE' ELSE 'SUSPENDED' END FROM core.organizations o;

-- Todo negocio nuevo recibe una suscripción (ADVANCED/ACTIVE) aunque no se cree desde la consola (CLI, pruebas).
-- La consola la reemplaza de inmediato por el plan y estado elegidos.
CREATE FUNCTION platform.create_default_subscription() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  INSERT INTO platform.subscriptions (organization_id, plan_code, status) VALUES (NEW.id, 'ADVANCED', 'ACTIVE')
  ON CONFLICT (organization_id) DO NOTHING;
  RETURN NEW;
END
$$;
CREATE TRIGGER organizations_default_subscription AFTER INSERT ON core.organizations
  FOR EACH ROW EXECUTE FUNCTION platform.create_default_subscription();

-- ── Operadores de la plataforma (identidad propia, no son usuarios de ningún negocio) ──
CREATE TABLE platform.operators (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+$'),
  display_name    text NOT NULL CHECK (length(btrim(display_name)) > 0),
  password_hash   text NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX operators_email_unique ON platform.operators (email);
CREATE TRIGGER operators_updated BEFORE UPDATE ON platform.operators
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE platform.operator_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES platform.operators (id),
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  ip          text,
  user_agent  text
);
CREATE INDEX operator_sessions_operator_idx ON platform.operator_sessions (operator_id);

-- Estas tablas son del plano de plataforma: sin organization_id propio de tenant y sin acceso de app_user.
INSERT INTO core.tenant_exempt_tables (table_schema, table_name, reason) VALUES
  ('platform', 'plans',               'catálogo de planes de la plataforma; app_user sin privilegios (el negocio ve su plan por core.current_entitlements)'),
  ('platform', 'subscriptions',       'suscripción por negocio, administrada por la plataforma; app_user sin privilegios'),
  ('platform', 'subscription_events', 'historial de suscripciones (solo-agregar); app_user sin privilegios'),
  ('platform', 'operators',           'operadores de la plataforma (no pertenecen a ningún negocio); app_user sin privilegios'),
  ('platform', 'operator_sessions',   'sesiones de operadores; app_user sin privilegios');

-- ── Lo que el negocio SÍ puede ver de su plan (función-puerta) ─────────────────
GRANT USAGE ON SCHEMA platform TO gate_owner;
GRANT SELECT ON platform.subscriptions, platform.plans TO gate_owner;
GRANT SELECT ON core.employees TO gate_owner;

CREATE FUNCTION core.current_entitlements()
RETURNS TABLE (plan_code text, plan_name text, subscription_status text, trial_ends_at timestamptz, current_period_end timestamptz,
               max_branches integer, max_employees integer, max_kiosks integer, max_members integer, features jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS
$$
  SELECT s.plan_code, p.name, s.status, s.trial_ends_at, s.current_period_end,
         p.max_branches, p.max_employees, p.max_kiosks, p.max_members, p.features
  FROM platform.subscriptions s JOIN platform.plans p ON p.code = s.plan_code
  WHERE s.organization_id = core.current_org()
$$;
ALTER FUNCTION core.current_entitlements() OWNER TO gate_owner;
REVOKE ALL ON FUNCTION core.current_entitlements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.current_entitlements() TO app_user, platform_ops;

-- ── Límites del plan en PostgreSQL (última línea de defensa, D-86) ─────────────
-- Solo para el tráfico del panel de clientes (session_user = app_user, también dentro de las funciones-puerta).
-- Cuentan únicamente los registros ACTIVOS; desactivar libera cupo y bajar de plan no toca datos existentes.
CREATE FUNCTION core.enforce_plan_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS
$$
DECLARE
  v_limit integer;
  v_count integer;
  v_active boolean;
  v_was_active boolean := false;
  v_code text;
BEGIN
  IF session_user <> 'app_user' THEN RETURN NEW; END IF;

  IF TG_TABLE_NAME = 'branches' THEN
    v_active := NEW.is_active; v_code := 'PLAN_LIMIT_BRANCHES';
    IF TG_OP = 'UPDATE' THEN v_was_active := OLD.is_active; END IF;
  ELSIF TG_TABLE_NAME = 'employees' THEN
    v_active := NEW.status = 'ACTIVE'; v_code := 'PLAN_LIMIT_EMPLOYEES';
    IF TG_OP = 'UPDATE' THEN v_was_active := OLD.status = 'ACTIVE'; END IF;
  ELSIF TG_TABLE_NAME = 'kiosk_devices' THEN
    v_active := NEW.status = 'ACTIVE'; v_code := 'PLAN_LIMIT_KIOSKS';
    IF TG_OP = 'UPDATE' THEN v_was_active := OLD.status = 'ACTIVE'; END IF;
  ELSE -- organization_memberships
    v_active := NEW.status = 'ACTIVE'; v_code := 'PLAN_LIMIT_MEMBERS';
    IF TG_OP = 'UPDATE' THEN v_was_active := OLD.status = 'ACTIVE'; END IF;
  END IF;
  IF NOT v_active OR v_was_active THEN RETURN NEW; END IF;

  SELECT CASE TG_TABLE_NAME WHEN 'branches' THEN p.max_branches WHEN 'employees' THEN p.max_employees
                            WHEN 'kiosk_devices' THEN p.max_kiosks ELSE p.max_members END
    INTO v_limit
    FROM platform.subscriptions s JOIN platform.plans p ON p.code = s.plan_code
   WHERE s.organization_id = NEW.organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SUBSCRIPTION_NOT_FOUND'; END IF;
  IF v_limit IS NULL THEN RETURN NEW; END IF;

  IF TG_TABLE_NAME = 'branches' THEN
    SELECT count(*) INTO v_count FROM core.branches WHERE organization_id = NEW.organization_id AND is_active;
  ELSIF TG_TABLE_NAME = 'employees' THEN
    SELECT count(*) INTO v_count FROM core.employees WHERE organization_id = NEW.organization_id AND status = 'ACTIVE';
  ELSIF TG_TABLE_NAME = 'kiosk_devices' THEN
    SELECT count(*) INTO v_count FROM core.kiosk_devices WHERE organization_id = NEW.organization_id AND status = 'ACTIVE';
  ELSE
    SELECT count(*) INTO v_count FROM core.organization_memberships WHERE organization_id = NEW.organization_id AND status = 'ACTIVE';
  END IF;
  IF v_count >= v_limit THEN RAISE EXCEPTION '%', v_code; END IF;
  RETURN NEW;
END
$$;
ALTER FUNCTION core.enforce_plan_limit() OWNER TO gate_owner;
REVOKE ALL ON FUNCTION core.enforce_plan_limit() FROM PUBLIC;

CREATE TRIGGER branches_plan_limit BEFORE INSERT OR UPDATE OF is_active ON core.branches
  FOR EACH ROW EXECUTE FUNCTION core.enforce_plan_limit();
CREATE TRIGGER employees_plan_limit BEFORE INSERT OR UPDATE OF status ON core.employees
  FOR EACH ROW EXECUTE FUNCTION core.enforce_plan_limit();
CREATE TRIGGER kiosk_devices_plan_limit BEFORE INSERT OR UPDATE OF status ON core.kiosk_devices
  FOR EACH ROW EXECUTE FUNCTION core.enforce_plan_limit();
CREATE TRIGGER memberships_plan_limit BEFORE INSERT OR UPDATE OF status ON core.organization_memberships
  FOR EACH ROW EXECUTE FUNCTION core.enforce_plan_limit();

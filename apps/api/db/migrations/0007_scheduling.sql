-- 0007 · Fase 2: planificación → horario semanal → turno concreto (D-22 … D-32).
-- El TURNO CONCRETO es la fuente de verdad para asistencia; las plantillas solo ayudan a generar semanas.

CREATE SCHEMA IF NOT EXISTS scheduling;
GRANT USAGE ON SCHEMA scheduling TO app_user, platform_ops;
ALTER DEFAULT PRIVILEGES IN SCHEMA scheduling GRANT SELECT, INSERT, UPDATE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA scheduling GRANT SELECT, INSERT, UPDATE ON TABLES TO platform_ops;

-- ── Política: duración válida de un turno (RN-HOR-02), heredable negocio → sucursal ─
ALTER TABLE platform.policy_defaults
  ADD COLUMN shift_min_minutes integer NOT NULL DEFAULT 60  CHECK (shift_min_minutes BETWEEN 15 AND 1440),
  ADD COLUMN shift_max_minutes integer NOT NULL DEFAULT 960 CHECK (shift_max_minutes BETWEEN 15 AND 1440);
ALTER TABLE core.policy_overrides
  ADD COLUMN shift_min_minutes integer CHECK (shift_min_minutes BETWEEN 15 AND 1440),
  ADD COLUMN shift_max_minutes integer CHECK (shift_max_minutes BETWEEN 15 AND 1440);
ALTER TABLE core.policy_overrides DROP CONSTRAINT employee_scope_params;
ALTER TABLE core.policy_overrides ADD CONSTRAINT employee_scope_params CHECK (scope <> 'EMPLOYEE' OR (
      early_entry_window_min IS NULL AND absent_after_min IS NULL AND operational_cutoff IS NULL
  AND max_hours_unscheduled IS NULL AND debounce_sec IS NULL AND pin_max_attempts IS NULL
  AND pin_lockout_sec IS NULL AND pin_lockout_max_sec IS NULL AND week_start_day IS NULL
  AND shift_min_minutes IS NULL AND shift_max_minutes IS NULL));

-- ── Permisos nuevos ────────────────────────────────────────────────────────────
INSERT INTO core.permissions (code, description) VALUES
  ('schedules.view',            'Ver horarios y turnos de su alcance'),
  ('schedules.history.manage',  'Corregir turnos que ya comenzaron o terminaron (con motivo)'),
  ('schedules.templates.manage','Administrar plantillas de horario');
ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE core.role_permissions NO FORCE ROW LEVEL SECURITY;
-- ADMIN recibe todo el catálogo; ENCARGADO ve y programa (siempre limitado a su alcance; revocable por negocio)
INSERT INTO core.role_permissions (organization_id, role_id, permission_code)
SELECT r.organization_id, r.id, p.code FROM core.roles r
 CROSS JOIN (VALUES ('schedules.view'), ('schedules.history.manage'), ('schedules.templates.manage'), ('schedules.manage')) AS p(code)
 WHERE r.name = 'ADMIN' AND r.is_system
ON CONFLICT DO NOTHING;
INSERT INTO core.role_permissions (organization_id, role_id, permission_code)
SELECT r.organization_id, r.id, p.code FROM core.roles r
 CROSS JOIN (VALUES ('schedules.view'), ('schedules.manage')) AS p(code)
 WHERE r.name = 'ENCARGADO' AND r.is_system
ON CONFLICT DO NOTHING;
ALTER TABLE core.role_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE core.roles FORCE ROW LEVEL SECURITY;

-- ── Horario semanal (planificación) por sucursal ───────────────────────────────
CREATE TABLE scheduling.weekly_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  branch_id       uuid NOT NULL,
  week_start      date NOT NULL,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED')),
  version         integer NOT NULL DEFAULT 1,          -- concurrencia optimista
  published_at    timestamptz,
  published_by    uuid,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, id, branch_id),
  UNIQUE (organization_id, branch_id, week_start),
  FOREIGN KEY (organization_id, branch_id) REFERENCES core.branches (organization_id, id),
  CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL))
);
CREATE TRIGGER weekly_schedules_updated BEFORE UPDATE ON scheduling.weekly_schedules
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
-- Publicar es irreversible: un horario publicado nunca vuelve a borrador
CREATE FUNCTION scheduling.forbid_unpublish() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF OLD.status = 'PUBLISHED' AND NEW.status <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'Un horario publicado no puede volver a borrador' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER weekly_schedules_no_unpublish BEFORE UPDATE OF status ON scheduling.weekly_schedules
  FOR EACH ROW EXECUTE FUNCTION scheduling.forbid_unpublish();
SELECT core.enable_tenant_rls('scheduling.weekly_schedules');

-- ── Turno concreto: fuente de verdad (D-22) ────────────────────────────────────
CREATE TABLE scheduling.shifts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES core.organizations (id),
  schedule_id        uuid NOT NULL,
  branch_id          uuid NOT NULL,
  employee_id        uuid NOT NULL,
  business_date      date NOT NULL,                     -- fecha local en que INICIA (D-27)
  starts_at          timestamptz NOT NULL,              -- UTC
  ends_at            timestamptz NOT NULL,              -- UTC
  timezone_snapshot  text NOT NULL,                     -- zona usada al crearlo (D-26)
  scheduled_minutes  integer GENERATED ALWAYS AS ((EXTRACT(EPOCH FROM (ends_at - starts_at)) / 60)::integer) STORED,
  status             text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'CANCELLED')),  -- D-25
  cancelled_at       timestamptz,
  cancelled_by       uuid,
  cancel_reason      text,
  notes              text,
  source             text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'COPY', 'TEMPLATE')),
  source_shift_id    uuid,                               -- turno de origen (copiar semana)
  source_template_id uuid,                               -- plantilla de origen (solo referencia)
  version            integer NOT NULL DEFAULT 1,         -- concurrencia optimista
  created_by         uuid,
  updated_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  -- la sucursal del turno es la del horario semanal al que pertenece; todo dentro del mismo negocio
  FOREIGN KEY (organization_id, schedule_id, branch_id) REFERENCES scheduling.weekly_schedules (organization_id, id, branch_id),
  FOREIGN KEY (organization_id, branch_id)   REFERENCES core.branches  (organization_id, id),
  FOREIGN KEY (organization_id, employee_id) REFERENCES core.employees (organization_id, id),
  CONSTRAINT shift_range CHECK (ends_at > starts_at),                                          -- D-27
  CONSTRAINT shift_max_24h CHECK (ends_at - starts_at <= interval '24 hours'),
  CONSTRAINT shift_cancel_data CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)
                                      AND (status <> 'CANCELLED' OR length(btrim(coalesce(cancel_reason, ''))) > 0)),
  -- D-29: sin traslapes del mismo empleado entre turnos activos, aunque sean de sucursales distintas. [inicio, fin)
  CONSTRAINT shift_no_overlap EXCLUDE USING gist (employee_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
    WHERE (status = 'SCHEDULED')
);
CREATE FUNCTION scheduling.assert_valid_timezone_snapshot() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z
                  WHERE z.name = NEW.timezone_snapshot AND (z.name LIKE '%/%' OR z.name = 'UTC')) THEN
    RAISE EXCEPTION 'Zona horaria inválida: %', NEW.timezone_snapshot USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shifts_tz BEFORE INSERT OR UPDATE OF timezone_snapshot ON scheduling.shifts
  FOR EACH ROW EXECUTE FUNCTION scheduling.assert_valid_timezone_snapshot();

-- Un turno CANCELADO queda congelado (se conserva tal cual; no se "revive" ni se edita).
-- Solo se puede BORRAR un turno de un horario en BORRADOR (nunca publicado). Nada de hard delete de publicados.
CREATE FUNCTION scheduling.guard_shift_changes() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Un turno cancelado no se puede modificar' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM scheduling.weekly_schedules w WHERE w.id = OLD.schedule_id AND w.status <> 'DRAFT') THEN
      RAISE EXCEPTION 'Un turno de un horario publicado no se borra: se cancela' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shifts_guard BEFORE UPDATE OR DELETE ON scheduling.shifts
  FOR EACH ROW EXECUTE FUNCTION scheduling.guard_shift_changes();
CREATE TRIGGER shifts_updated BEFORE UPDATE ON scheduling.shifts
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE INDEX shifts_by_branch_time   ON scheduling.shifts (organization_id, branch_id, starts_at);
CREATE INDEX shifts_by_employee_time ON scheduling.shifts (organization_id, employee_id, starts_at);
CREATE INDEX shifts_by_schedule      ON scheduling.shifts (organization_id, schedule_id);
-- Copiar semana es idempotente: un mismo turno de origen no se copia dos veces al mismo horario
CREATE UNIQUE INDEX shifts_copy_once ON scheduling.shifts (organization_id, schedule_id, source_shift_id)
  WHERE source_shift_id IS NOT NULL AND status = 'SCHEDULED';
SELECT core.enable_tenant_rls('scheduling.shifts');
GRANT DELETE ON scheduling.shifts TO app_user;   -- el trigger solo lo permite en borradores

-- ── Plantillas (D-23): ayudan a generar semanas; NUNCA modifican turnos existentes ─
CREATE TABLE scheduling.schedule_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  branch_id       uuid NOT NULL,
  name            text NOT NULL CHECK (length(btrim(name)) > 0),
  is_active       boolean NOT NULL DEFAULT true,
  version         integer NOT NULL DEFAULT 1,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, branch_id, name),
  FOREIGN KEY (organization_id, branch_id) REFERENCES core.branches (organization_id, id)
);
CREATE TRIGGER schedule_templates_updated BEFORE UPDATE ON scheduling.schedule_templates
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT core.enable_tenant_rls('scheduling.schedule_templates');

CREATE TABLE scheduling.schedule_template_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  template_id     uuid NOT NULL,
  employee_id     uuid NOT NULL,
  weekday         smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO: 1 = lunes … 7 = domingo
  start_local     time NOT NULL,
  end_local       time NOT NULL,                                       -- ≤ inicio ⇒ termina al día siguiente
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (template_id, employee_id, weekday, start_local),
  FOREIGN KEY (organization_id, template_id) REFERENCES scheduling.schedule_templates (organization_id, id),
  FOREIGN KEY (organization_id, employee_id) REFERENCES core.employees (organization_id, id),
  CHECK (end_local <> start_local)
);
SELECT core.enable_tenant_rls('scheduling.schedule_template_entries');
GRANT DELETE ON scheduling.schedule_template_entries TO app_user;  -- las entradas se reemplazan al editar (auditado)

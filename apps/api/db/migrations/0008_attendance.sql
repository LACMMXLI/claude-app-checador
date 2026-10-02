-- 0008 · Fase 3: asistencia — jornadas reales, eventos físicos inmutables, pausas, incidencias y
-- correcciones (D-33 … D-65). Separación definitiva: Shift = lo que debía trabajar; WorkSession = lo que ocurrió.

-- ── D-33: un turno de un horario PUBLICADO nunca termina en un horario que no esté publicado ──────────
CREATE FUNCTION scheduling.guard_published_shift_move() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF NEW.schedule_id IS DISTINCT FROM OLD.schedule_id
     AND EXISTS (SELECT 1 FROM scheduling.weekly_schedules w WHERE w.id = OLD.schedule_id AND w.status = 'PUBLISHED')
     AND NOT EXISTS (SELECT 1 FROM scheduling.weekly_schedules w WHERE w.id = NEW.schedule_id AND w.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'SHIFT_TARGET_SCHEDULE_NOT_PUBLISHED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shifts_published_move BEFORE UPDATE OF schedule_id ON scheduling.shifts
  FOR EACH ROW EXECUTE FUNCTION scheduling.guard_published_shift_move();

-- Para que una jornada solo pueda ligarse a un turno del MISMO empleado y la MISMA sucursal (FK compuesta).
ALTER TABLE scheduling.shifts ADD CONSTRAINT shifts_org_id_employee_branch_uk UNIQUE (organization_id, id, employee_id, branch_id);

-- ── D-48: jornada abierta anormalmente larga (reemplaza a `max_hours_unscheduled`, que nunca se usó) ──
ALTER TABLE platform.policy_defaults DROP CONSTRAINT policy_defaults_max_hours_unscheduled_check;
ALTER TABLE platform.policy_defaults RENAME COLUMN max_hours_unscheduled TO max_open_session_minutes;
UPDATE platform.policy_defaults SET max_open_session_minutes = 960;
ALTER TABLE platform.policy_defaults
  ALTER COLUMN max_open_session_minutes SET DEFAULT 960,
  ADD CONSTRAINT policy_defaults_max_open_session_minutes_check CHECK (max_open_session_minutes BETWEEN 60 AND 2880);

ALTER TABLE core.policy_overrides NO FORCE ROW LEVEL SECURITY;
ALTER TABLE core.policy_overrides DROP CONSTRAINT policy_overrides_max_hours_unscheduled_check;
ALTER TABLE core.policy_overrides RENAME COLUMN max_hours_unscheduled TO max_open_session_minutes;
UPDATE core.policy_overrides SET max_open_session_minutes = LEAST(max_open_session_minutes * 60, 2880) WHERE max_open_session_minutes IS NOT NULL;
ALTER TABLE core.policy_overrides
  ADD CONSTRAINT policy_overrides_max_open_session_minutes_check CHECK (max_open_session_minutes BETWEEN 60 AND 2880);
ALTER TABLE core.policy_overrides FORCE ROW LEVEL SECURITY;

-- ── Esquema de asistencia ──────────────────────────────────────────────────────
CREATE SCHEMA attendance;
GRANT USAGE ON SCHEMA attendance TO app_user, platform_ops;

-- Minutos entre dos instantes truncando los segundos de cada uno (RN §9). Basado en epoch: no depende de zona.
CREATE FUNCTION attendance.minutes_between(a timestamptz, b timestamptz) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT (floor(extract(epoch FROM (b - timestamptz '1970-01-01 00:00:00+00')) / 60)
         - floor(extract(epoch FROM (a - timestamptz '1970-01-01 00:00:00+00')) / 60))::integer $$;

-- ── Jornada real (D-37). started_at / ended_at son los valores EFECTIVOS; lo físico vive en `events` ─
CREATE TABLE attendance.work_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES core.organizations (id),
  branch_id        uuid NOT NULL,                 -- donde realmente ocurrió (D-36)
  employee_id      uuid NOT NULL,
  shift_id         uuid,                          -- nullable: jornadas sin turno (D-6, D-34)
  operational_date date NOT NULL,                 -- D-46
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz,                   -- NUNCA se inventa (D-9, D-47, D-48)
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'REVIEW', 'CLOSED')),
  origin           text NOT NULL CHECK (origin IN ('KIOSK', 'CORRECTION')),
  policy_snapshot  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- política efectiva usada (RN-CAL-05)
  version          integer NOT NULL DEFAULT 1,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, id, employee_id),
  FOREIGN KEY (organization_id, branch_id)   REFERENCES core.branches (organization_id, id),
  FOREIGN KEY (organization_id, employee_id) REFERENCES core.employees (organization_id, id),
  -- el turno ligado es del mismo negocio, del mismo empleado y de la misma sucursal (D-35/D-36)
  CONSTRAINT work_session_shift_fk FOREIGN KEY (organization_id, shift_id, employee_id, branch_id)
    REFERENCES scheduling.shifts (organization_id, id, employee_id, branch_id),
  CONSTRAINT work_session_closed_has_end CHECK ((status = 'CLOSED') = (ended_at IS NOT NULL)),
  CONSTRAINT work_session_end_after_start CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- dos jornadas completas del mismo empleado no se traslapan
  CONSTRAINT work_session_no_overlap EXCLUDE USING gist (employee_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&)
    WHERE (ended_at IS NOT NULL)
);
-- D-40: una sola jornada ABIERTA por empleado dentro del negocio (aunque cheque en otra sucursal)
CREATE UNIQUE INDEX work_sessions_one_open ON attendance.work_sessions (organization_id, employee_id) WHERE status = 'OPEN';
-- un turno se liga a lo más a una jornada
CREATE UNIQUE INDEX work_sessions_one_per_shift ON attendance.work_sessions (organization_id, shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX work_sessions_by_branch_date ON attendance.work_sessions (organization_id, branch_id, operational_date);
CREATE INDEX work_sessions_by_employee ON attendance.work_sessions (organization_id, employee_id, started_at DESC);
CREATE TRIGGER work_sessions_updated BEFORE UPDATE ON attendance.work_sessions
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT core.enable_tenant_rls('attendance.work_sessions');

-- ── Pausas como registros independientes (D-14, D-49) ──────────────────────────
CREATE TABLE attendance.breaks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES core.organizations (id),
  work_session_id   uuid NOT NULL,
  sequence          smallint NOT NULL CHECK (sequence >= 1),
  started_at        timestamptz NOT NULL,
  ended_at          timestamptz,                  -- nunca se inventa el regreso (D-50)
  allowed_minutes   integer NOT NULL CHECK (allowed_minutes >= 0),     -- snapshot de la política
  tolerance_minutes integer NOT NULL DEFAULT 0 CHECK (tolerance_minutes >= 0),
  duration_minutes  integer GENERATED ALWAYS AS (
    CASE WHEN ended_at IS NULL THEN NULL ELSE attendance.minutes_between(started_at, ended_at) END) STORED,
  exceeded_minutes  integer GENERATED ALWAYS AS (
    CASE WHEN ended_at IS NULL THEN NULL
         ELSE GREATEST(0, attendance.minutes_between(started_at, ended_at) - allowed_minutes - tolerance_minutes) END) STORED,
  origin            text NOT NULL CHECK (origin IN ('KIOSK', 'CORRECTION')),
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, id, work_session_id),
  UNIQUE (organization_id, work_session_id, sequence),
  FOREIGN KEY (organization_id, work_session_id) REFERENCES attendance.work_sessions (organization_id, id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX breaks_one_open ON attendance.breaks (organization_id, work_session_id) WHERE ended_at IS NULL;
CREATE TRIGGER breaks_updated BEFORE UPDATE ON attendance.breaks FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT core.enable_tenant_rls('attendance.breaks');

-- ── Eventos físicos del kiosco: INMUTABLES, idempotentes, preparados para offline (D-12, D-38, D-54) ─
CREATE TABLE attendance.events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  branch_id       uuid NOT NULL,                  -- sucursal del kiosco donde ocurrió físicamente
  employee_id     uuid NOT NULL,
  work_session_id uuid NOT NULL,
  break_id        uuid,
  type            text NOT NULL CHECK (type IN ('CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT')),
  client_event_id uuid NOT NULL,
  device_id       uuid NOT NULL,
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL DEFAULT 'KIOSK_ONLINE' CHECK (source IN ('KIOSK_ONLINE', 'KIOSK_OFFLINE_SYNC')),
  time_source     text NOT NULL DEFAULT 'SERVER' CHECK (time_source IN ('SERVER', 'DEVICE')),
  UNIQUE (organization_id, id),
  CONSTRAINT events_idempotency UNIQUE (organization_id, device_id, client_event_id),  -- reenviar no duplica (D-54)
  FOREIGN KEY (organization_id, branch_id)   REFERENCES core.branches (organization_id, id),
  FOREIGN KEY (organization_id, employee_id) REFERENCES core.employees (organization_id, id),
  FOREIGN KEY (organization_id, device_id)   REFERENCES core.kiosk_devices (organization_id, id),
  FOREIGN KEY (organization_id, work_session_id, employee_id) REFERENCES attendance.work_sessions (organization_id, id, employee_id),
  FOREIGN KEY (organization_id, break_id, work_session_id)    REFERENCES attendance.breaks (organization_id, id, work_session_id),
  CHECK ((type IN ('BREAK_START', 'BREAK_END')) = (break_id IS NOT NULL))
);
CREATE INDEX events_by_session ON attendance.events (organization_id, work_session_id, occurred_at);
CREATE INDEX events_by_employee ON attendance.events (organization_id, employee_id, occurred_at DESC);
SELECT core.enable_tenant_rls('attendance.events');
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON attendance.events
  FOR EACH ROW EXECUTE FUNCTION core.forbid_mutation();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON attendance.events
  FOR EACH STATEMENT EXECUTE FUNCTION core.forbid_mutation();

-- ── Incidencias (RN-INC-*). Nunca se borran: se resuelven ───────────────────────
CREATE TABLE attendance.incidents (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES core.organizations (id),
  branch_id                uuid NOT NULL,
  employee_id              uuid NOT NULL,
  work_session_id          uuid,
  shift_id                 uuid,
  operational_date         date NOT NULL,
  type                     text NOT NULL CHECK (type IN (
    'RETARDO', 'FALTA', 'SIN_TURNO_PROGRAMADO', 'SIN_ASIGNACION_SUCURSAL', 'TURNO_EN_OTRA_SUCURSAL', 'ENTRADA_FALTANTE',
    'SALIDA_OLVIDADA', 'JORNADA_ABIERTA_EXCEDIDA', 'REGRESO_COMIDA_FALTANTE', 'COMIDA_EXCEDIDA')),
  status                   text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  details                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at              timestamptz NOT NULL DEFAULT now(),
  detected_by              text NOT NULL CHECK (detected_by IN ('KIOSK', 'RECONCILER', 'CORRECTION')),
  resolution               text CHECK (resolution IN ('CORRECTED', 'JUSTIFIED', 'CONFIRMED', 'DISMISSED')),
  resolved_at              timestamptz,
  resolved_by              uuid,
  resolution_reason        text,
  resolution_correction_id uuid,
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, branch_id)   REFERENCES core.branches (organization_id, id),
  FOREIGN KEY (organization_id, employee_id) REFERENCES core.employees (organization_id, id),
  FOREIGN KEY (organization_id, work_session_id, employee_id) REFERENCES attendance.work_sessions (organization_id, id, employee_id),
  FOREIGN KEY (organization_id, shift_id)    REFERENCES scheduling.shifts (organization_id, id),
  CHECK (work_session_id IS NOT NULL OR shift_id IS NOT NULL),
  CHECK (type <> 'FALTA' OR (shift_id IS NOT NULL AND work_session_id IS NULL)),
  CONSTRAINT incident_resolution CHECK (
    (status = 'OPEN' AND resolution IS NULL AND resolved_at IS NULL)
    OR (status = 'RESOLVED' AND resolution IS NOT NULL AND resolved_at IS NOT NULL AND length(btrim(coalesce(resolution_reason, ''))) > 0))
);
-- idempotencia: una incidencia ABIERTA por tipo y jornada; una sola FALTA por turno, aunque ya esté resuelta (D-44)
CREATE UNIQUE INDEX incidents_open_per_session ON attendance.incidents (organization_id, work_session_id, type)
  WHERE work_session_id IS NOT NULL AND status = 'OPEN';
CREATE UNIQUE INDEX incidents_one_falta_per_shift ON attendance.incidents (organization_id, shift_id) WHERE type = 'FALTA';
CREATE INDEX incidents_by_branch_date ON attendance.incidents (organization_id, branch_id, operational_date);
CREATE TRIGGER incidents_updated BEFORE UPDATE ON attendance.incidents FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE FUNCTION attendance.guard_incident() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF OLD.status = 'RESOLVED' THEN
    RAISE EXCEPTION 'Una incidencia resuelta no se modifica (se conserva el historial)' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER incidents_guard BEFORE UPDATE ON attendance.incidents FOR EACH ROW EXECUTE FUNCTION attendance.guard_incident();
SELECT core.enable_tenant_rls('attendance.incidents');

-- ── Correcciones (D-51, D-52): acciones de dominio, solo-agregar, original y corregido ─
CREATE TABLE attendance.corrections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  branch_id       uuid NOT NULL,                  -- sucursal donde ocurrió la jornada (alcance, D-18)
  employee_id     uuid NOT NULL,
  work_session_id uuid NOT NULL,
  break_id        uuid,
  incident_id     uuid,
  action          text NOT NULL CHECK (action IN (
    'CREATE_SESSION', 'SET_CLOCK_IN', 'SET_CLOCK_OUT', 'SET_BREAK_START', 'SET_BREAK_END', 'LINK_SHIFT', 'UNLINK_SHIFT')),
  original_value  jsonb,                          -- valor antes de la corrección (lo físico, si era el primero)
  corrected_value jsonb NOT NULL,                 -- valor efectivo nuevo
  before          jsonb,                          -- jornada completa antes
  after           jsonb NOT NULL,                 -- jornada completa después
  reason          text NOT NULL CHECK (length(btrim(reason)) > 0),
  corrected_by    uuid NOT NULL,
  corrected_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, branch_id)   REFERENCES core.branches (organization_id, id),
  FOREIGN KEY (organization_id, employee_id) REFERENCES core.employees (organization_id, id),
  FOREIGN KEY (organization_id, work_session_id, employee_id) REFERENCES attendance.work_sessions (organization_id, id, employee_id),
  FOREIGN KEY (organization_id, break_id, work_session_id)    REFERENCES attendance.breaks (organization_id, id, work_session_id),
  FOREIGN KEY (organization_id, incident_id) REFERENCES attendance.incidents (organization_id, id)
);
CREATE INDEX corrections_by_session ON attendance.corrections (organization_id, work_session_id, corrected_at);
SELECT core.enable_tenant_rls('attendance.corrections');
CREATE TRIGGER corrections_immutable BEFORE UPDATE OR DELETE ON attendance.corrections
  FOR EACH ROW EXECUTE FUNCTION core.forbid_mutation();
CREATE TRIGGER corrections_no_truncate BEFORE TRUNCATE ON attendance.corrections
  FOR EACH STATEMENT EXECUTE FUNCTION core.forbid_mutation();
-- D-18: nadie corrige su propia jornada (también en la BD; el servicio lo valida antes con un error claro)
CREATE FUNCTION attendance.forbid_self_correction() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF EXISTS (SELECT 1 FROM core.organization_memberships m
              WHERE m.organization_id = NEW.organization_id AND m.user_id = NEW.corrected_by AND m.employee_id = NEW.employee_id) THEN
    RAISE EXCEPTION 'SELF_CORRECTION_FORBIDDEN';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER corrections_not_self BEFORE INSERT ON attendance.corrections
  FOR EACH ROW EXECUTE FUNCTION attendance.forbid_self_correction();

ALTER TABLE attendance.incidents ADD FOREIGN KEY (organization_id, resolution_correction_id)
  REFERENCES attendance.corrections (organization_id, id);

-- ── Invariantes de la jornada en PostgreSQL ────────────────────────────────────
-- * solo se liga a turnos OFICIALES: SCHEDULED y de un horario PUBLISHED (D-34, D-62, D-63)
-- * no se cierra con una pausa abierta (D-50) · una jornada cerrada no se reabre
-- Si el turno no es visible (otro negocio) no se decide aquí: lo rechazan RLS y las FKs.
CREATE FUNCTION attendance.guard_work_session() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  v_shift_status text;
  v_schedule_status text;
BEGIN
  IF NEW.shift_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.shift_id IS DISTINCT FROM OLD.shift_id) THEN
    SELECT s.status, w.status INTO v_shift_status, v_schedule_status
      FROM scheduling.shifts s JOIN scheduling.weekly_schedules w ON w.id = s.schedule_id
     WHERE s.id = NEW.shift_id;
    IF FOUND AND (v_shift_status <> 'SCHEDULED' OR v_schedule_status <> 'PUBLISHED') THEN
      RAISE EXCEPTION 'SHIFT_NOT_OFFICIAL';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'CLOSED' AND NEW.status <> 'CLOSED' THEN
      RAISE EXCEPTION 'SESSION_ALREADY_CLOSED';
    END IF;
    IF NEW.ended_at IS NOT NULL AND OLD.ended_at IS NULL
       AND EXISTS (SELECT 1 FROM attendance.breaks b WHERE b.work_session_id = NEW.id AND b.ended_at IS NULL) THEN
      RAISE EXCEPTION 'BREAK_OPEN';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER work_sessions_guard BEFORE INSERT OR UPDATE ON attendance.work_sessions
  FOR EACH ROW EXECUTE FUNCTION attendance.guard_work_session();

-- Un turno que ya tiene jornada real no se cancela (lo trabajado no "desaparece" del plan).
CREATE FUNCTION scheduling.guard_shift_with_attendance() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF NEW.status = 'CANCELLED' AND OLD.status = 'SCHEDULED'
     AND EXISTS (SELECT 1 FROM attendance.work_sessions ws WHERE ws.shift_id = OLD.id) THEN
    RAISE EXCEPTION 'SHIFT_HAS_ATTENDANCE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shifts_attendance_guard BEFORE UPDATE OF status ON scheduling.shifts
  FOR EACH ROW EXECUTE FUNCTION scheduling.guard_shift_with_attendance();

-- ── Privilegios: sin DELETE; UPDATE solo en las columnas que cambian por reglas de dominio ─
GRANT SELECT, INSERT ON attendance.work_sessions, attendance.breaks, attendance.events, attendance.incidents, attendance.corrections TO app_user;
GRANT UPDATE (shift_id, operational_date, started_at, ended_at, status, version) ON attendance.work_sessions TO app_user;
GRANT UPDATE (started_at, ended_at, version) ON attendance.breaks TO app_user;
GRANT UPDATE (status, resolution, resolved_at, resolved_by, resolution_reason, resolution_correction_id, details, version)
  ON attendance.incidents TO app_user;
GRANT SELECT ON attendance.work_sessions, attendance.breaks, attendance.events, attendance.incidents, attendance.corrections TO platform_ops;

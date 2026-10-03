-- 0009 · Fase 4 (D-66 … D-77): salida anticipada, sin comida, pausa omitida, FALTA anulada por el plan,
-- solicitudes de corrección con aprobación y avisos para el tiempo real (SSE). Contrato: docs/05-fase-4-contrato.md.

-- ── Políticas nuevas (D-68, D-70) ──────────────────────────────────────────────
ALTER TABLE platform.policy_defaults
  ADD COLUMN break_required_after_min        integer NOT NULL DEFAULT 0 CHECK (break_required_after_min BETWEEN 0 AND 1440),
  ADD COLUMN correction_request_window_days  integer NOT NULL DEFAULT 7 CHECK (correction_request_window_days BETWEEN 1 AND 31),
  ADD COLUMN max_pending_correction_requests integer NOT NULL DEFAULT 3 CHECK (max_pending_correction_requests BETWEEN 1 AND 20);
ALTER TABLE core.policy_overrides
  ADD COLUMN break_required_after_min        integer CHECK (break_required_after_min BETWEEN 0 AND 1440),
  ADD COLUMN correction_request_window_days  integer CHECK (correction_request_window_days BETWEEN 1 AND 31),
  ADD COLUMN max_pending_correction_requests integer CHECK (max_pending_correction_requests BETWEEN 1 AND 20);
ALTER TABLE core.policy_overrides DROP CONSTRAINT employee_scope_params;
ALTER TABLE core.policy_overrides ADD CONSTRAINT employee_scope_params CHECK (scope <> 'EMPLOYEE' OR (
      early_entry_window_min IS NULL AND absent_after_min IS NULL AND operational_cutoff IS NULL
  AND max_open_session_minutes IS NULL AND debounce_sec IS NULL AND pin_max_attempts IS NULL
  AND pin_lockout_sec IS NULL AND pin_lockout_max_sec IS NULL AND week_start_day IS NULL
  AND shift_min_minutes IS NULL AND shift_max_minutes IS NULL
  AND correction_request_window_days IS NULL AND max_pending_correction_requests IS NULL));
ALTER TABLE core.policy_overrides DROP CONSTRAINT organization_only_params;
ALTER TABLE core.policy_overrides ADD CONSTRAINT organization_only_params
  CHECK (scope = 'ORGANIZATION' OR (week_start_day IS NULL AND max_pending_correction_requests IS NULL));

-- ── ENCARGADO puede SOLICITAR correcciones de su propia ficha (decisión 6; revocable por negocio) ──
ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE core.role_permissions NO FORCE ROW LEVEL SECURITY;
INSERT INTO core.role_permissions (organization_id, role_id, permission_code)
SELECT r.organization_id, r.id, 'attendance.correction.request' FROM core.roles r
 WHERE r.name IN ('ENCARGADO', 'ADMIN') AND r.is_system
ON CONFLICT DO NOTHING;
ALTER TABLE core.role_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE core.roles FORCE ROW LEVEL SECURITY;

-- ── Incidencias: tipos nuevos, anulación por el sistema y origen de la resolución (D-66, D-67, D-68) ──
ALTER TABLE attendance.incidents DROP CONSTRAINT incidents_type_check;
ALTER TABLE attendance.incidents ADD CONSTRAINT incidents_type_check CHECK (type IN (
  'RETARDO', 'FALTA', 'SIN_TURNO_PROGRAMADO', 'SIN_ASIGNACION_SUCURSAL', 'TURNO_EN_OTRA_SUCURSAL', 'ENTRADA_FALTANTE',
  'SALIDA_OLVIDADA', 'JORNADA_ABIERTA_EXCEDIDA', 'REGRESO_COMIDA_FALTANTE', 'COMIDA_EXCEDIDA',
  'SALIDA_ANTICIPADA', 'SIN_COMIDA'));
ALTER TABLE attendance.incidents DROP CONSTRAINT incidents_resolution_check;
ALTER TABLE attendance.incidents ADD CONSTRAINT incidents_resolution_check
  CHECK (resolution IN ('CORRECTED', 'JUSTIFIED', 'CONFIRMED', 'DISMISSED', 'VOIDED'));
ALTER TABLE attendance.incidents ADD COLUMN resolution_source text CHECK (resolution_source IN ('USER', 'CORRECTION', 'SYSTEM'));
-- datos existentes: una incidencia resuelta es inmutable (trigger), así que el relleno se hace con el trigger apagado
ALTER TABLE attendance.incidents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance.incidents DISABLE TRIGGER incidents_guard;
UPDATE attendance.incidents SET resolution_source = CASE WHEN resolution = 'CORRECTED' THEN 'CORRECTION' ELSE 'USER' END
 WHERE status = 'RESOLVED';
ALTER TABLE attendance.incidents ENABLE TRIGGER incidents_guard;
ALTER TABLE attendance.incidents FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance.incidents ADD CONSTRAINT incident_resolution_source CHECK (
  (status = 'OPEN' AND resolution_source IS NULL)
  OR (status = 'RESOLVED' AND resolution_source IS NOT NULL
      AND (resolution = 'VOIDED') = (resolution_source = 'SYSTEM')
      AND (resolution = 'CORRECTED') = (resolution_source = 'CORRECTION')));
GRANT UPDATE (resolution_source) ON attendance.incidents TO app_user;

-- Una sola FALTA NO anulada por turno (si se anula por reasignación o reprogramación, la reconciliación puede generar
-- la que corresponda después). Las anuladas se conservan.
DROP INDEX attendance.incidents_one_falta_per_shift;
CREATE UNIQUE INDEX incidents_one_active_falta_per_shift ON attendance.incidents (organization_id, shift_id)
  WHERE type = 'FALTA' AND (resolution IS NULL OR resolution <> 'VOIDED');
CREATE INDEX incidents_by_employee_date ON attendance.incidents (organization_id, employee_id, operational_date);

-- Guarda: una FALTA solo para un turno OFICIAL, del mismo empleado y sucursal, y sin jornada (cierra la carrera entre la
-- reconciliación y una cancelación). Si el turno no es visible (otro negocio) lo rechazan RLS y las FKs.
CREATE FUNCTION attendance.guard_falta_insert() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  v_status text; v_schedule text; v_employee uuid; v_branch uuid;
BEGIN
  IF NEW.type <> 'FALTA' THEN RETURN NEW; END IF;
  SELECT s.status, w.status, s.employee_id, s.branch_id INTO v_status, v_schedule, v_employee, v_branch
    FROM scheduling.shifts s JOIN scheduling.weekly_schedules w ON w.id = s.schedule_id
   WHERE s.id = NEW.shift_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF v_status <> 'SCHEDULED' OR v_schedule <> 'PUBLISHED' OR v_employee <> NEW.employee_id OR v_branch <> NEW.branch_id
     OR EXISTS (SELECT 1 FROM attendance.work_sessions ws WHERE ws.shift_id = NEW.shift_id) THEN
    RAISE EXCEPTION 'FALTA_NOT_APPLICABLE';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER incidents_falta_guard BEFORE INSERT ON attendance.incidents
  FOR EACH ROW EXECUTE FUNCTION attendance.guard_falta_insert();

-- D-66: al cancelar o reasignar (empleado o sucursal) un turno, su FALTA abierta queda ANULADA por el sistema, con
-- motivo y auditoría, en la MISMA transacción. Nunca se borra. (La reprogramación a futuro depende de la hora de la
-- aplicación y la hace el servicio de planificación.)
CREATE FUNCTION scheduling.void_falta_on_shift_change() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  v_reason text;
BEGIN
  IF NEW.status = 'CANCELLED' AND OLD.status = 'SCHEDULED' THEN
    v_reason := 'SHIFT_CANCELLED: ' || coalesce(NEW.cancel_reason, '');
  ELSIF NEW.employee_id <> OLD.employee_id OR NEW.branch_id <> OLD.branch_id THEN
    v_reason := 'SHIFT_REASSIGNED';
  ELSE
    RETURN NEW;
  END IF;
  WITH voided AS (
    UPDATE attendance.incidents i
       SET status = 'RESOLVED', resolution = 'VOIDED', resolution_source = 'SYSTEM', resolved_at = now(),
           resolved_by = core.current_user_id(), resolution_reason = v_reason, version = i.version + 1
     WHERE i.shift_id = OLD.id AND i.type = 'FALTA' AND i.status = 'OPEN'
    RETURNING i.id, i.branch_id)
  INSERT INTO audit.audit_log (organization_id, branch_id, actor_type, actor_user_id, action, entity_type, entity_id, before, after, reason)
  SELECT NEW.organization_id, v.branch_id, 'SYSTEM', core.current_user_id(), 'attendance.incident_voided', 'incident', v.id::text,
         jsonb_build_object('type', 'FALTA', 'status', 'OPEN'),
         jsonb_build_object('type', 'FALTA', 'status', 'RESOLVED', 'resolution', 'VOIDED', 'shiftId', OLD.id),
         v_reason
    FROM voided v;
  RETURN NEW;
END
$$;
CREATE TRIGGER shifts_void_falta AFTER UPDATE OF status, employee_id, branch_id ON scheduling.shifts
  FOR EACH ROW EXECUTE FUNCTION scheduling.void_falta_on_shift_change();

-- ── Correcciones: pausa omitida (D-69) ─────────────────────────────────────────
ALTER TABLE attendance.corrections DROP CONSTRAINT corrections_action_check;
ALTER TABLE attendance.corrections ADD CONSTRAINT corrections_action_check CHECK (action IN (
  'CREATE_SESSION', 'SET_CLOCK_IN', 'SET_CLOCK_OUT', 'SET_BREAK_START', 'SET_BREAK_END', 'LINK_SHIFT', 'UNLINK_SHIFT', 'ADD_BREAK'));
ALTER TABLE attendance.corrections ADD COLUMN request_id uuid;

-- ── Solicitudes de corrección (D-70, D-71) ─────────────────────────────────────
CREATE TABLE attendance.correction_requests (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL REFERENCES core.organizations (id),
  branch_id                  uuid NOT NULL,           -- donde ocurrió la jornada (alcance de quien aprueba)
  employee_id                uuid NOT NULL,           -- SIEMPRE la propia ficha del solicitante
  operational_date           date NOT NULL,           -- día operativo del objetivo (ventana de la solicitud, precisión A)
  action                     text NOT NULL CHECK (action IN (
    'SET_CLOCK_IN', 'SET_CLOCK_OUT', 'SET_BREAK_START', 'SET_BREAK_END', 'ADD_BREAK', 'CREATE_SESSION')),
  work_session_id            uuid,
  break_id                   uuid,
  shift_id                   uuid,
  incident_id                uuid,
  proposed_start             timestamptz NOT NULL,
  proposed_end               timestamptz,
  proposed_local             jsonb NOT NULL DEFAULT '{}'::jsonb,   -- lo que capturó el empleado (fecha, hora, zona)
  reason                     text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  channel                    text NOT NULL CHECK (channel IN ('KIOSK', 'PANEL')),
  requested_by_user_id       uuid,
  requested_device_id        uuid,
  client_request_id          uuid NOT NULL,
  status                     text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  decided_by                 uuid,
  decided_at                 timestamptz,
  decision_reason            text,
  correction_id              uuid,
  session_version_at_request integer,
  version                    integer NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, branch_id)   REFERENCES core.branches (organization_id, id),
  FOREIGN KEY (organization_id, employee_id) REFERENCES core.employees (organization_id, id),
  FOREIGN KEY (organization_id, work_session_id, employee_id) REFERENCES attendance.work_sessions (organization_id, id, employee_id),
  FOREIGN KEY (organization_id, break_id, work_session_id)    REFERENCES attendance.breaks (organization_id, id, work_session_id),
  -- el turno de una CREATE_SESSION es del MISMO empleado y de la MISMA sucursal
  FOREIGN KEY (organization_id, shift_id, employee_id, branch_id) REFERENCES scheduling.shifts (organization_id, id, employee_id, branch_id),
  FOREIGN KEY (organization_id, incident_id) REFERENCES attendance.incidents (organization_id, id),
  FOREIGN KEY (organization_id, requested_device_id) REFERENCES core.kiosk_devices (organization_id, id),
  FOREIGN KEY (organization_id, correction_id) REFERENCES attendance.corrections (organization_id, id),
  CONSTRAINT request_channel CHECK (
       (channel = 'KIOSK' AND requested_device_id IS NOT NULL AND requested_by_user_id IS NULL)
    OR (channel = 'PANEL' AND requested_by_user_id IS NOT NULL AND requested_device_id IS NULL)),
  -- columnas obligatorias por acción (así las columnas de los índices únicos nunca son NULL: precisión B)
  CONSTRAINT request_target CHECK (
       (action IN ('SET_CLOCK_IN', 'SET_CLOCK_OUT') AND work_session_id IS NOT NULL AND break_id IS NULL AND shift_id IS NULL AND proposed_end IS NULL)
    OR (action IN ('SET_BREAK_START', 'SET_BREAK_END') AND work_session_id IS NOT NULL AND break_id IS NOT NULL AND shift_id IS NULL AND proposed_end IS NULL)
    OR (action = 'ADD_BREAK' AND work_session_id IS NOT NULL AND break_id IS NULL AND shift_id IS NULL AND proposed_end IS NOT NULL)
    OR (action = 'CREATE_SESSION' AND work_session_id IS NULL AND break_id IS NULL AND proposed_end IS NOT NULL)),
  CONSTRAINT request_interval CHECK (proposed_end IS NULL OR proposed_end > proposed_start),
  CONSTRAINT request_decision CHECK (
       (status = 'PENDING'   AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL AND correction_id IS NULL)
    OR (status = 'APPROVED'  AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND correction_id IS NOT NULL)
    OR (status = 'REJECTED'  AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND correction_id IS NULL
                             AND length(btrim(coalesce(decision_reason, ''))) > 0)
    OR (status = 'CANCELLED' AND decided_at IS NOT NULL AND correction_id IS NULL))
);
-- Unicidad REAL de "una solicitud pendiente igual" por acción (precisión B)
CREATE UNIQUE INDEX requests_pending_session_time ON attendance.correction_requests (organization_id, work_session_id, action)
  WHERE status = 'PENDING' AND action IN ('SET_CLOCK_IN', 'SET_CLOCK_OUT');
CREATE UNIQUE INDEX requests_pending_break_time ON attendance.correction_requests (organization_id, break_id, action)
  WHERE status = 'PENDING' AND action IN ('SET_BREAK_START', 'SET_BREAK_END');
CREATE UNIQUE INDEX requests_pending_add_break ON attendance.correction_requests (organization_id, work_session_id)
  WHERE status = 'PENDING' AND action = 'ADD_BREAK';
CREATE UNIQUE INDEX requests_pending_create_with_shift ON attendance.correction_requests (organization_id, shift_id)
  WHERE status = 'PENDING' AND action = 'CREATE_SESSION' AND shift_id IS NOT NULL;
CREATE UNIQUE INDEX requests_pending_create_without_shift ON attendance.correction_requests (organization_id, employee_id, operational_date)
  WHERE status = 'PENDING' AND action = 'CREATE_SESSION' AND shift_id IS NULL;
-- Idempotencia de la solicitud (reintentos del kiosco o del panel)
CREATE UNIQUE INDEX requests_idempotency_device ON attendance.correction_requests (organization_id, requested_device_id, client_request_id)
  WHERE requested_device_id IS NOT NULL;
CREATE UNIQUE INDEX requests_idempotency_user ON attendance.correction_requests (organization_id, requested_by_user_id, client_request_id)
  WHERE requested_by_user_id IS NOT NULL;
CREATE INDEX requests_by_status_branch ON attendance.correction_requests (organization_id, status, branch_id, created_at DESC);
CREATE INDEX requests_by_employee ON attendance.correction_requests (organization_id, employee_id, created_at DESC);
CREATE TRIGGER correction_requests_updated BEFORE UPDATE ON attendance.correction_requests
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT core.enable_tenant_rls('attendance.correction_requests');

-- El día operativo guardado coincide con el del objetivo (si es visible; si no, deciden RLS y las FKs).
CREATE FUNCTION attendance.guard_request_insert() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  v_date date;
BEGIN
  IF NEW.work_session_id IS NOT NULL THEN
    SELECT operational_date INTO v_date FROM attendance.work_sessions WHERE id = NEW.work_session_id;
  ELSIF NEW.shift_id IS NOT NULL THEN
    SELECT business_date INTO v_date FROM scheduling.shifts WHERE id = NEW.shift_id;
  END IF;
  IF v_date IS NOT NULL AND v_date <> NEW.operational_date THEN
    RAISE EXCEPTION 'REQUEST_DATE_MISMATCH';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER correction_requests_insert_guard BEFORE INSERT ON attendance.correction_requests
  FOR EACH ROW EXECUTE FUNCTION attendance.guard_request_insert();

-- Solo PENDING → APPROVED | REJECTED | CANCELLED; un estado terminal es inmutable; nadie decide su propia solicitud.
CREATE FUNCTION attendance.guard_request_update() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'REQUEST_ALREADY_DECIDED';
  END IF;
  IF NEW.status IN ('APPROVED', 'REJECTED') AND (
       NEW.decided_by = OLD.requested_by_user_id
    OR EXISTS (SELECT 1 FROM core.organization_memberships m
                WHERE m.organization_id = OLD.organization_id AND m.user_id = NEW.decided_by AND m.employee_id = OLD.employee_id)) THEN
    RAISE EXCEPTION 'SELF_APPROVAL_FORBIDDEN';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER correction_requests_update_guard BEFORE UPDATE ON attendance.correction_requests
  FOR EACH ROW EXECUTE FUNCTION attendance.guard_request_update();

GRANT SELECT, INSERT ON attendance.correction_requests TO app_user;
-- solo las columnas de la DECISIÓN cambian; el contenido de la solicitud es inmutable por privilegios
GRANT UPDATE (status, decided_by, decided_at, decision_reason, correction_id, version) ON attendance.correction_requests TO app_user;
GRANT SELECT ON attendance.correction_requests TO platform_ops;

ALTER TABLE attendance.corrections ADD CONSTRAINT corrections_request_fk
  FOREIGN KEY (organization_id, request_id) REFERENCES attendance.correction_requests (organization_id, id);
CREATE UNIQUE INDEX corrections_one_per_request ON attendance.corrections (organization_id, request_id) WHERE request_id IS NOT NULL;

-- ── Avisos de cambio para el tiempo real (D-75): INVALIDACIONES sin datos personales ──────────────
-- NOTIFY es transaccional: solo se entrega si la transacción se confirma. Canal por negocio.
CREATE FUNCTION attendance.notify_change() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  v_kind text := TG_ARGV[0];
  v_id uuid := NEW.id;
  v_branch uuid;
BEGIN
  IF TG_TABLE_NAME = 'breaks' THEN
    SELECT ws.branch_id INTO v_branch FROM attendance.work_sessions ws WHERE ws.id = NEW.work_session_id;
    v_id := NEW.work_session_id;
  ELSE
    v_branch := NEW.branch_id;
  END IF;
  PERFORM pg_notify('att_' || replace(NEW.organization_id::text, '-', ''),
                    json_build_object('k', v_kind, 'id', v_id, 'b', v_branch, 'op', lower(TG_OP))::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER work_sessions_notify AFTER INSERT OR UPDATE ON attendance.work_sessions
  FOR EACH ROW EXECUTE FUNCTION attendance.notify_change('session');
CREATE TRIGGER breaks_notify AFTER INSERT OR UPDATE ON attendance.breaks
  FOR EACH ROW EXECUTE FUNCTION attendance.notify_change('session');
CREATE TRIGGER incidents_notify AFTER INSERT OR UPDATE ON attendance.incidents
  FOR EACH ROW EXECUTE FUNCTION attendance.notify_change('incident');
CREATE TRIGGER correction_requests_notify AFTER INSERT OR UPDATE ON attendance.correction_requests
  FOR EACH ROW EXECUTE FUNCTION attendance.notify_change('request');

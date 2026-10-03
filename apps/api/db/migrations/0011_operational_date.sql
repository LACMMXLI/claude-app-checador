-- 0011 · D-78: UN solo día operativo para todo lo de asistencia.
-- Regla: mientras no llega la hora de corte del negocio/sucursal (política `operational_cutoff`, en su zona IANA), la
-- actividad pertenece al día operativo ANTERIOR. Con corte 05:00 en America/Tijuana: 03-oct 04:59:59 ⇒ 02-oct;
-- 03-oct 05:00:00 ⇒ 03-oct. Aplica también a los TURNOS: hasta ahora el turno usaba `business_date` (la fecha de
-- planeación, D-27) y por eso un turno que empieza entre 00:00 y el corte quedaba en un día distinto al del tablero.
--
-- * `scheduling.shifts.operational_date` = día operativo del INICIO del turno, calculado por la aplicación con la función
--   canónica `operationalDate` (src/common/operational-day.ts) al crear/editar. `business_date` sigue siendo solo la
--   columna del horario semanal (planeación); NINGUNA consulta de asistencia la usa.
-- * Una jornada ligada a un turno, la FALTA de un turno y una solicitud sobre un turno comparten SU día operativo
--   (lo garantiza PostgreSQL). Los instantes reales nunca cambian: solo la fecha con la que se agrupa.

-- Gemela SQL de la función canónica, SOLO para rellenar datos en migraciones (no se usa en tiempo de ejecución).
-- Una prueba verifica que da exactamente lo mismo que la versión TypeScript (fronteras, DST, medianoche).
CREATE FUNCTION core.operational_date(p_instant timestamptz, p_timezone text, p_cutoff time)
RETURNS date LANGUAGE sql IMMUTABLE STRICT AS
$$
  SELECT CASE WHEN date_trunc('minute', (p_instant AT TIME ZONE p_timezone))::time < date_trunc('minute', p_cutoff::interval)::time
              THEN (p_instant AT TIME ZONE p_timezone)::date - 1
              ELSE (p_instant AT TIME ZONE p_timezone)::date END
$$;

-- Lectura sin contexto de negocio durante la migración (patrón NO FORCE / FORCE, ver 04-operacion §7)
ALTER TABLE core.organizations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE core.branches NO FORCE ROW LEVEL SECURITY;
ALTER TABLE core.policy_overrides NO FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduling.shifts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance.work_sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance.incidents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance.correction_requests NO FORCE ROW LEVEL SECURITY;

ALTER TABLE scheduling.shifts ADD COLUMN operational_date date;

-- Un turno cancelado está congelado por trigger: el relleno es un dato derivado, no una edición del turno.
ALTER TABLE scheduling.shifts DISABLE TRIGGER shifts_guard;
ALTER TABLE scheduling.shifts DISABLE TRIGGER shifts_updated;
-- Zona efectiva (sucursal → negocio) y corte efectivo (sucursal → negocio → plataforma) de cada sucursal
UPDATE scheduling.shifts s
   SET operational_date = core.operational_date(s.starts_at, c.timezone, c.cutoff)
  FROM (SELECT b.id AS branch_id,
               COALESCE(b.timezone, o.timezone) AS timezone,
               COALESCE(pb.operational_cutoff, po.operational_cutoff, pd.operational_cutoff) AS cutoff
          FROM core.branches b
          JOIN core.organizations o ON o.id = b.organization_id
          CROSS JOIN platform.policy_defaults pd
          LEFT JOIN core.policy_overrides po ON po.organization_id = b.organization_id AND po.scope = 'ORGANIZATION'
          LEFT JOIN core.policy_overrides pb ON pb.organization_id = b.organization_id AND pb.scope = 'BRANCH' AND pb.branch_id = b.id) c
 WHERE c.branch_id = s.branch_id;
ALTER TABLE scheduling.shifts ENABLE TRIGGER shifts_updated;
ALTER TABLE scheduling.shifts ENABLE TRIGGER shifts_guard;
ALTER TABLE scheduling.shifts ALTER COLUMN operational_date SET NOT NULL;
CREATE INDEX shifts_by_branch_operational_date ON scheduling.shifts (organization_id, branch_id, operational_date);

-- Jornadas ligadas a un turno: su día operativo es el del turno (antes era `business_date`)
UPDATE attendance.work_sessions ws
   SET operational_date = s.operational_date
  FROM scheduling.shifts s
 WHERE s.id = ws.shift_id AND ws.operational_date <> s.operational_date;

-- Incidencias: las de una jornada siguen a su jornada; la FALTA (sin jornada) sigue a su turno.
-- Una incidencia resuelta es inmutable por trigger; aquí solo se corrige la fecha de agrupación.
ALTER TABLE attendance.incidents DISABLE TRIGGER incidents_guard;
UPDATE attendance.incidents i
   SET operational_date = ws.operational_date
  FROM attendance.work_sessions ws
 WHERE ws.id = i.work_session_id AND i.operational_date <> ws.operational_date;
UPDATE attendance.incidents i
   SET operational_date = s.operational_date
  FROM scheduling.shifts s
 WHERE i.work_session_id IS NULL AND s.id = i.shift_id AND i.operational_date <> s.operational_date;
ALTER TABLE attendance.incidents ENABLE TRIGGER incidents_guard;

-- Solicitudes sobre una jornada o un turno (las terminales son inmutables por trigger)
ALTER TABLE attendance.correction_requests DISABLE TRIGGER correction_requests_update_guard;
UPDATE attendance.correction_requests r
   SET operational_date = ws.operational_date
  FROM attendance.work_sessions ws
 WHERE ws.id = r.work_session_id AND r.operational_date <> ws.operational_date;
UPDATE attendance.correction_requests r
   SET operational_date = s.operational_date
  FROM scheduling.shifts s
 WHERE r.work_session_id IS NULL AND s.id = r.shift_id AND r.operational_date <> s.operational_date;
ALTER TABLE attendance.correction_requests ENABLE TRIGGER correction_requests_update_guard;

ALTER TABLE attendance.correction_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance.incidents FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance.work_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduling.shifts FORCE ROW LEVEL SECURITY;
ALTER TABLE core.policy_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE core.branches FORCE ROW LEVEL SECURITY;
ALTER TABLE core.organizations FORCE ROW LEVEL SECURITY;

-- ── Invariantes (PostgreSQL como última línea de defensa) ────────────────────────────────────────────────

-- Una jornada ligada a un turno tiene EXACTAMENTE el día operativo del turno.
CREATE FUNCTION attendance.guard_session_operational_date() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  v_date date;
BEGIN
  IF NEW.shift_id IS NULL THEN RETURN NEW; END IF;
  SELECT operational_date INTO v_date FROM scheduling.shifts WHERE id = NEW.shift_id;
  IF FOUND AND v_date <> NEW.operational_date THEN
    RAISE EXCEPTION 'SESSION_DATE_MISMATCH';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER work_sessions_operational_date BEFORE INSERT OR UPDATE OF shift_id, operational_date ON attendance.work_sessions
  FOR EACH ROW EXECUTE FUNCTION attendance.guard_session_operational_date();

-- Un turno que ya tiene jornada real no cambia de día operativo (igual que no cambia de empleado ni de sucursal).
CREATE FUNCTION scheduling.guard_shift_operational_date() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.operational_date IS DISTINCT FROM OLD.operational_date
     AND EXISTS (SELECT 1 FROM attendance.work_sessions ws WHERE ws.shift_id = OLD.id) THEN
    RAISE EXCEPTION 'SHIFT_HAS_ATTENDANCE';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER shifts_operational_date_guard BEFORE UPDATE OF operational_date ON scheduling.shifts
  FOR EACH ROW EXECUTE FUNCTION scheduling.guard_shift_operational_date();

-- La FALTA lleva el día operativo de su turno.
CREATE OR REPLACE FUNCTION attendance.guard_falta_insert() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  v_status text; v_schedule text; v_employee uuid; v_branch uuid; v_date date;
BEGIN
  IF NEW.type <> 'FALTA' THEN RETURN NEW; END IF;
  SELECT s.status, w.status, s.employee_id, s.branch_id, s.operational_date INTO v_status, v_schedule, v_employee, v_branch, v_date
    FROM scheduling.shifts s JOIN scheduling.weekly_schedules w ON w.id = s.schedule_id
   WHERE s.id = NEW.shift_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF v_status <> 'SCHEDULED' OR v_schedule <> 'PUBLISHED' OR v_employee <> NEW.employee_id OR v_branch <> NEW.branch_id
     OR EXISTS (SELECT 1 FROM attendance.work_sessions ws WHERE ws.shift_id = NEW.shift_id) THEN
    RAISE EXCEPTION 'FALTA_NOT_APPLICABLE';
  END IF;
  IF v_date <> NEW.operational_date THEN
    RAISE EXCEPTION 'INCIDENT_DATE_MISMATCH';
  END IF;
  RETURN NEW;
END
$$;

-- Una solicitud sobre un turno usa el día operativo del turno (antes: `business_date`).
CREATE OR REPLACE FUNCTION attendance.guard_request_insert() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  v_date date;
BEGIN
  IF NEW.work_session_id IS NOT NULL THEN
    SELECT operational_date INTO v_date FROM attendance.work_sessions WHERE id = NEW.work_session_id;
  ELSIF NEW.shift_id IS NOT NULL THEN
    SELECT operational_date INTO v_date FROM scheduling.shifts WHERE id = NEW.shift_id;
  END IF;
  IF v_date IS NOT NULL AND v_date <> NEW.operational_date THEN
    RAISE EXCEPTION 'REQUEST_DATE_MISMATCH';
  END IF;
  RETURN NEW;
END
$$;

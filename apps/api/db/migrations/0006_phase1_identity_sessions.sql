-- 0006 · Fase 1: D-21 (bloqueo corto del kiosco), sesiones, invitaciones y tokens de kiosco regenerables.
--
-- Nota operativa: las tablas de negocio tienen FORCE ROW LEVEL SECURITY, que también aplica al dueño
-- (`migrator`). Para corregir DATOS dentro de una migración se usa el patrón:
--   ALTER TABLE x NO FORCE ROW LEVEL SECURITY;  …UPDATE…;  ALTER TABLE x FORCE ROW LEVEL SECURITY;
-- todo dentro de la misma transacción (la migración), de modo que nunca queda desprotegida.

-- ── D-21: pausa corta y progresiva por dispositivo, con tope global (nunca 1 h) ─
ALTER TABLE platform.policy_defaults DROP CONSTRAINT policy_defaults_pin_lockout_sec_check;
ALTER TABLE platform.policy_defaults
  ADD CONSTRAINT policy_defaults_pin_lockout_sec_check CHECK (pin_lockout_sec BETWEEN 1 AND 300),
  ALTER COLUMN pin_lockout_sec SET DEFAULT 10,
  ADD COLUMN pin_lockout_max_sec integer NOT NULL DEFAULT 120 CHECK (pin_lockout_max_sec BETWEEN 1 AND 300);
UPDATE platform.policy_defaults SET pin_lockout_sec = 10, pin_lockout_max_sec = 120;

ALTER TABLE core.policy_overrides NO FORCE ROW LEVEL SECURITY;
UPDATE core.policy_overrides SET pin_lockout_sec = LEAST(pin_lockout_sec, 300) WHERE pin_lockout_sec > 300;
ALTER TABLE core.policy_overrides DROP CONSTRAINT policy_overrides_pin_lockout_sec_check;
ALTER TABLE core.policy_overrides
  ADD CONSTRAINT policy_overrides_pin_lockout_sec_check CHECK (pin_lockout_sec BETWEEN 1 AND 300),
  ADD COLUMN pin_lockout_max_sec integer CHECK (pin_lockout_max_sec BETWEEN 1 AND 300);
ALTER TABLE core.policy_overrides DROP CONSTRAINT employee_scope_params;
ALTER TABLE core.policy_overrides ADD CONSTRAINT employee_scope_params CHECK (scope <> 'EMPLOYEE' OR (
      early_entry_window_min IS NULL AND absent_after_min IS NULL AND operational_cutoff IS NULL
  AND max_hours_unscheduled IS NULL AND debounce_sec IS NULL AND pin_max_attempts IS NULL
  AND pin_lockout_sec IS NULL AND pin_lockout_max_sec IS NULL AND week_start_day IS NULL));
ALTER TABLE core.policy_overrides FORCE ROW LEVEL SECURITY;

-- ── Kioscos: dispositivo (ACTIVO/INACTIVO) separado de su token (generar/revocar/regenerar) ─
ALTER TABLE core.kiosk_devices NO FORCE ROW LEVEL SECURITY;
ALTER TABLE core.kiosk_devices DROP CONSTRAINT kiosk_devices_check;
ALTER TABLE core.kiosk_devices DROP CONSTRAINT kiosk_devices_status_check;
ALTER TABLE core.kiosk_devices RENAME COLUMN revoked_at TO token_revoked_at;
ALTER TABLE core.kiosk_devices
  ALTER COLUMN token_prefix DROP NOT NULL,
  ALTER COLUMN token_hash DROP NOT NULL,
  ADD COLUMN token_issued_at timestamptz;
UPDATE core.kiosk_devices SET token_issued_at = created_at WHERE token_hash IS NOT NULL;
UPDATE core.kiosk_devices
   SET status = 'INACTIVE', token_prefix = NULL, token_hash = NULL, token_issued_at = NULL,
       token_revoked_at = COALESCE(token_revoked_at, now())
 WHERE status = 'REVOKED';
ALTER TABLE core.kiosk_devices
  ADD CONSTRAINT kiosk_devices_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  ADD CONSTRAINT kiosk_devices_token_pair CHECK ((token_prefix IS NULL) = (token_hash IS NULL)),
  ADD CONSTRAINT kiosk_devices_token_issued CHECK ((token_hash IS NULL) = (token_issued_at IS NULL));
ALTER TABLE core.kiosk_devices FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION auth.redeem_pairing_code(p_code_hash text, p_name text, p_prefix text, p_token_hash text)
RETURNS TABLE (r_device_id uuid, r_organization_id uuid, r_branch_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS
$$
DECLARE
  v_code core.kiosk_pairing_codes%ROWTYPE;
  v_device uuid;
BEGIN
  SELECT * INTO v_code FROM core.kiosk_pairing_codes c
   WHERE c.code_hash = p_code_hash AND c.used_at IS NULL AND c.expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM core.organizations o WHERE o.id = v_code.organization_id AND o.status = 'ACTIVE') THEN
    RETURN;
  END IF;
  UPDATE core.kiosk_pairing_codes SET used_at = now() WHERE id = v_code.id;
  INSERT INTO core.kiosk_devices (organization_id, branch_id, name, token_prefix, token_hash, token_issued_at)
  VALUES (v_code.organization_id, v_code.branch_id, p_name, p_prefix, p_token_hash, now())
  RETURNING id INTO v_device;
  INSERT INTO audit.audit_log (organization_id, branch_id, actor_type, actor_device_id, action, entity_type, entity_id, after)
  VALUES (v_code.organization_id, v_code.branch_id, 'KIOSK', v_device, 'kiosk.paired', 'kiosk_device', v_device::text,
          jsonb_build_object('name', p_name));
  RETURN QUERY SELECT v_device, v_code.organization_id, v_code.branch_id;
END
$$;

-- ── Sesiones del panel (globales: identidad + negocio activo) ───────────────────
-- La cookie solo lleva un secreto aleatorio; aquí se guarda su SHA-256. app_user NO tiene acceso directo.
CREATE TABLE auth.sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id         uuid NOT NULL REFERENCES auth.users (id),
  organization_id uuid REFERENCES core.organizations (id),
  membership_id   uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  ip              text,
  user_agent      text,
  FOREIGN KEY (organization_id, membership_id) REFERENCES core.organization_memberships (organization_id, id),
  CHECK ((organization_id IS NULL) = (membership_id IS NULL)),
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_by_user ON auth.sessions (user_id) WHERE revoked_at IS NULL;
ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.sessions FORCE ROW LEVEL SECURITY;   -- sin políticas: solo roles con BYPASSRLS (funciones-puerta / plataforma)
REVOKE ALL ON auth.sessions FROM app_user;
INSERT INTO core.tenant_exempt_tables (table_schema, table_name, reason) VALUES
  ('auth', 'sessions', 'sesiones globales (identidad + negocio activo); app_user sin privilegios, solo funciones-puerta');

-- ── Invitaciones (por negocio): el admin invita; el usuario reclama y pone SUS credenciales ─
CREATE TABLE core.invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES core.organizations (id),
  email            text NOT NULL CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+$'),
  role_id          uuid NOT NULL,
  scope            text NOT NULL CHECK (scope IN ('ORGANIZATION', 'BRANCHES')),
  branch_ids       uuid[] NOT NULL DEFAULT '{}',
  token_hash       text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),   -- nunca el token
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  accepted_user_id uuid REFERENCES auth.users (id),
  revoked_at       timestamptz,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, role_id) REFERENCES core.roles (organization_id, id),
  CHECK ((scope = 'ORGANIZATION') = (cardinality(branch_ids) = 0)),
  CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL)),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX invitations_pending ON core.invitations (organization_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
SELECT core.enable_tenant_rls('core.invitations');

-- ── Privilegios de gate_owner para las nuevas funciones-puerta ─────────────────
GRANT SELECT, INSERT, UPDATE ON auth.sessions TO gate_owner;
GRANT SELECT, UPDATE ON core.invitations TO gate_owner;
GRANT INSERT ON auth.users, auth.user_credentials TO gate_owner;
GRANT INSERT, UPDATE ON core.organization_memberships TO gate_owner;
GRANT SELECT ON core.roles TO gate_owner;
GRANT SELECT, INSERT ON core.role_assignments, core.role_assignment_branches TO gate_owner;

-- Crear sesión (login). Solo para identidades ACTIVAS.
CREATE FUNCTION auth.create_session(p_user_id uuid, p_token_hash text, p_expires_at timestamptz, p_ip text, p_user_agent text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS
$$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id AND u.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'USER_NOT_ACTIVE' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO auth.sessions (token_hash, user_id, expires_at, ip, user_agent)
  VALUES (p_token_hash, p_user_id, p_expires_at, p_ip, p_user_agent) RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- Resolver la sesión de una petición. La identidad deshabilitada invalida la sesión; la membresía
-- inactiva o el negocio suspendido solo quitan el negocio activo (la identidad sigue autenticada).
CREATE FUNCTION auth.resolve_session(p_token_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, email text, display_name text, organization_id uuid, membership_id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS
$$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH touched AS (
    UPDATE auth.sessions s SET last_seen_at = now()
      FROM auth.users u
     WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
       AND u.id = s.user_id AND u.status = 'ACTIVE'
    RETURNING s.id AS sid, s.user_id AS uid, u.email AS em, u.display_name AS dn,
              s.organization_id AS oid, s.membership_id AS mid, s.expires_at AS exp
  )
  SELECT t.sid, t.uid, t.em, t.dn,
         CASE WHEN ok.valid THEN t.oid END,
         CASE WHEN ok.valid THEN t.mid END,
         t.exp
    FROM touched t
    CROSS JOIN LATERAL (
      SELECT EXISTS (SELECT 1 FROM core.organization_memberships m JOIN core.organizations o ON o.id = m.organization_id
                      WHERE m.id = t.mid AND m.status = 'ACTIVE' AND o.status = 'ACTIVE') AS valid
    ) ok;
END
$$;

-- Seleccionar/cambiar de negocio: valida la membresía ACTIVA en un negocio ACTIVO, revoca la sesión
-- anterior y emite una NUEVA (rotación del identificador). Si no es válida, no cambia nada.
CREATE FUNCTION auth.switch_session_organization(p_old_hash text, p_new_hash text, p_organization_id uuid, p_ttl_seconds integer)
RETURNS TABLE (r_session_id uuid, r_membership_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS
$$
DECLARE
  v_session auth.sessions%ROWTYPE;
  v_membership uuid;
  v_new uuid;
BEGIN
  SELECT s.* INTO v_session FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id
   WHERE s.token_hash = p_old_hash AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'ACTIVE'
   FOR UPDATE OF s;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT m.id INTO v_membership FROM core.organization_memberships m JOIN core.organizations o ON o.id = m.organization_id
   WHERE m.user_id = v_session.user_id AND m.organization_id = p_organization_id AND m.status = 'ACTIVE' AND o.status = 'ACTIVE';
  IF v_membership IS NULL THEN RETURN; END IF;
  UPDATE auth.sessions SET revoked_at = now() WHERE id = v_session.id;
  INSERT INTO auth.sessions (token_hash, user_id, organization_id, membership_id, expires_at, ip, user_agent)
  VALUES (p_new_hash, v_session.user_id, p_organization_id, v_membership, now() + make_interval(secs => p_ttl_seconds), v_session.ip, v_session.user_agent)
  RETURNING id INTO v_new;
  INSERT INTO audit.audit_log (organization_id, actor_type, actor_user_id, action, entity_type, entity_id)
  VALUES (p_organization_id, 'USER', v_session.user_id, 'session.organization_selected', 'membership', v_membership::text);
  RETURN QUERY SELECT v_new, v_membership;
END
$$;

CREATE FUNCTION auth.revoke_session(p_token_hash text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS
$$ UPDATE auth.sessions SET revoked_at = now() WHERE token_hash = p_token_hash AND revoked_at IS NULL $$;

-- Vista previa de una invitación válida (para la pantalla de "reclamar cuenta").
CREATE FUNCTION auth.get_invitation(p_token_hash text)
RETURNS TABLE (invitation_id uuid, organization_id uuid, organization_name text, email text, expires_at timestamptz, user_exists boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS
$$
  SELECT i.id, o.id, o.name, i.email, i.expires_at, EXISTS (SELECT 1 FROM auth.users u WHERE u.email = i.email)
  FROM core.invitations i JOIN core.organizations o ON o.id = i.organization_id
  WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND o.status = 'ACTIVE'
$$;

-- Aceptar (uso único, atómico). Identidad nueva: se crea con la contraseña que ELIGE el invitado.
-- Identidad existente: NO se toca su contraseña; la API debe haber verificado sus credenciales actuales.
CREATE FUNCTION auth.accept_invitation(p_token_hash text, p_display_name text, p_password_hash text, p_verified_user_id uuid)
RETURNS TABLE (r_user_id uuid, r_organization_id uuid, r_membership_id uuid, r_created_user boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS
$$
DECLARE
  v_inv core.invitations%ROWTYPE;
  v_user uuid;
  v_created boolean := false;
  v_membership uuid;
  v_status text;
  v_assignment uuid;
BEGIN
  SELECT i.* INTO v_inv FROM core.invitations i
   WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVITATION_INVALID' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM core.organizations o WHERE o.id = v_inv.organization_id AND o.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'INVITATION_INVALID' USING ERRCODE = 'P0001';
  END IF;

  SELECT u.id INTO v_user FROM auth.users u WHERE u.email = v_inv.email;
  IF v_user IS NULL THEN
    IF p_password_hash IS NULL OR length(p_password_hash) < 20 THEN RAISE EXCEPTION 'PASSWORD_REQUIRED' USING ERRCODE = 'P0001'; END IF;
    INSERT INTO auth.users (email, display_name)
    VALUES (v_inv.email, COALESCE(NULLIF(btrim(p_display_name), ''), split_part(v_inv.email, '@', 1)))
    RETURNING id INTO v_user;
    INSERT INTO auth.user_credentials (user_id, password_hash) VALUES (v_user, p_password_hash);
    v_created := true;
  ELSIF p_verified_user_id IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'IDENTITY_VERIFICATION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  SELECT m.id, m.status INTO v_membership, v_status FROM core.organization_memberships m
   WHERE m.organization_id = v_inv.organization_id AND m.user_id = v_user;
  IF v_membership IS NULL THEN
    INSERT INTO core.organization_memberships (organization_id, user_id) VALUES (v_inv.organization_id, v_user) RETURNING id INTO v_membership;
  ELSIF v_status = 'ACTIVE' THEN
    RAISE EXCEPTION 'ALREADY_MEMBER' USING ERRCODE = 'P0001';
  ELSE
    UPDATE core.organization_memberships SET status = 'ACTIVE' WHERE id = v_membership;
  END IF;

  INSERT INTO core.role_assignments (organization_id, membership_id, role_id, scope)
  VALUES (v_inv.organization_id, v_membership, v_inv.role_id, v_inv.scope) RETURNING id INTO v_assignment;
  INSERT INTO core.role_assignment_branches (organization_id, assignment_id, branch_id)
  SELECT v_inv.organization_id, v_assignment, b FROM unnest(v_inv.branch_ids) AS b;   -- FK compuesta: solo sucursales del mismo negocio

  UPDATE core.invitations SET accepted_at = now(), accepted_user_id = v_user WHERE id = v_inv.id;
  INSERT INTO audit.audit_log (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, after)
  VALUES (v_inv.organization_id, 'USER', v_user, 'invitation.accepted', 'membership', v_membership::text,
          jsonb_build_object('invitationId', v_inv.id, 'createdUser', v_created, 'scope', v_inv.scope));
  RETURN QUERY SELECT v_user, v_inv.organization_id, v_membership, v_created;
END
$$;

ALTER FUNCTION auth.create_session(uuid, text, timestamptz, text, text)            OWNER TO gate_owner;
ALTER FUNCTION auth.resolve_session(text)                                           OWNER TO gate_owner;
ALTER FUNCTION auth.switch_session_organization(text, text, uuid, integer)          OWNER TO gate_owner;
ALTER FUNCTION auth.revoke_session(text)                                            OWNER TO gate_owner;
ALTER FUNCTION auth.get_invitation(text)                                            OWNER TO gate_owner;
ALTER FUNCTION auth.accept_invitation(text, text, text, uuid)                       OWNER TO gate_owner;
ALTER FUNCTION auth.redeem_pairing_code(text, text, text, text)                     OWNER TO gate_owner;

REVOKE ALL ON FUNCTION auth.create_session(uuid, text, timestamptz, text, text)    FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.resolve_session(text)                                   FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.switch_session_organization(text, text, uuid, integer)  FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.revoke_session(text)                                    FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.get_invitation(text)                                    FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.accept_invitation(text, text, text, uuid)               FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.redeem_pairing_code(text, text, text, text)             FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth.create_session(uuid, text, timestamptz, text, text)   TO app_user;
GRANT EXECUTE ON FUNCTION auth.resolve_session(text)                                  TO app_user;
GRANT EXECUTE ON FUNCTION auth.switch_session_organization(text, text, uuid, integer) TO app_user;
GRANT EXECUTE ON FUNCTION auth.revoke_session(text)                                   TO app_user;
GRANT EXECUTE ON FUNCTION auth.get_invitation(text)                                   TO app_user;
GRANT EXECUTE ON FUNCTION auth.accept_invitation(text, text, text, uuid)              TO app_user;
GRANT EXECUTE ON FUNCTION auth.redeem_pairing_code(text, text, text, text)            TO app_user, platform_ops;

-- ENCARGADO (rol de sistema): por defecto también administra empleados y PIN DENTRO de su alcance.
-- Para negocios ya existentes se agrega el permiso; cada negocio puede quitarlo después.
ALTER TABLE core.role_permissions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY;
INSERT INTO core.role_permissions (organization_id, role_id, permission_code)
SELECT r.organization_id, r.id, p.code FROM core.roles r
 CROSS JOIN (VALUES ('employees.manage'), ('employees.pin.manage')) AS p(code)
 WHERE r.name = 'ENCARGADO' AND r.is_system
ON CONFLICT DO NOTHING;
ALTER TABLE core.roles FORCE ROW LEVEL SECURITY;
ALTER TABLE core.role_permissions FORCE ROW LEVEL SECURITY;

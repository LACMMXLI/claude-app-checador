-- 0005 · Funciones-puerta: las ÚNICAS operaciones que ocurren antes de conocer el negocio.
-- SECURITY DEFINER, dueño gate_owner (BYPASSRLS, NOLOGIN, privilegios mínimos), search_path fijo,
-- EXECUTE solo para app_user / platform_ops. Cada una expone lo mínimo indispensable.

GRANT SELECT ON core.organizations, core.branches, core.kiosk_devices, core.organization_memberships TO gate_owner;
GRANT SELECT, UPDATE ON core.kiosk_pairing_codes TO gate_owner;
GRANT INSERT ON core.kiosk_devices TO gate_owner;
GRANT INSERT ON audit.audit_log TO gate_owner;
GRANT SELECT ON auth.users TO gate_owner;
GRANT SELECT, UPDATE ON auth.user_credentials TO gate_owner;

-- ── Kiosco: token ⇒ (device, organization, branch) ─────────────────────────────
CREATE FUNCTION auth.resolve_kiosk_token(p_prefix text)
RETURNS TABLE (device_id uuid, organization_id uuid, branch_id uuid, token_hash text, status text, organization_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS
$$
  SELECT d.id, d.organization_id, d.branch_id, d.token_hash, d.status, o.status
  FROM core.kiosk_devices d JOIN core.organizations o ON o.id = d.organization_id
  WHERE d.token_prefix = p_prefix
$$;

-- ── Kiosco: canje de código de emparejamiento (un solo uso, con vencimiento) ───
CREATE FUNCTION auth.redeem_pairing_code(p_code_hash text, p_name text, p_prefix text, p_token_hash text)
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
  INSERT INTO core.kiosk_devices (organization_id, branch_id, name, token_prefix, token_hash)
  VALUES (v_code.organization_id, v_code.branch_id, p_name, p_prefix, p_token_hash)
  RETURNING id INTO v_device;
  INSERT INTO audit.audit_log (organization_id, branch_id, actor_type, actor_device_id, action, entity_type, entity_id, after)
  VALUES (v_code.organization_id, v_code.branch_id, 'KIOSK', v_device, 'kiosk.paired', 'kiosk_device', v_device::text,
          jsonb_build_object('name', p_name));
  RETURN QUERY SELECT v_device, v_code.organization_id, v_code.branch_id;
END
$$;

-- ── Login: único camino a las credenciales globales ────────────────────────────
CREATE FUNCTION auth.get_login_record(p_email text)
RETURNS TABLE (user_id uuid, status text, password_hash text, failed_attempts integer, locked_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS
$$
  SELECT u.id, u.status, c.password_hash, c.failed_attempts, c.locked_until
  FROM auth.users u JOIN auth.user_credentials c ON c.user_id = u.id
  WHERE u.email = lower(btrim(p_email))
$$;

CREATE FUNCTION auth.record_login_result(p_user_id uuid, p_success boolean, p_max_attempts integer DEFAULT 5, p_lock_minutes integer DEFAULT 15)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS
$$
BEGIN
  IF p_success THEN
    UPDATE auth.user_credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = p_user_id;
  ELSE
    UPDATE auth.user_credentials
       SET failed_attempts = failed_attempts + 1,
           locked_until = CASE WHEN failed_attempts + 1 >= p_max_attempts
                               THEN now() + make_interval(mins => p_lock_minutes) ELSE locked_until END
     WHERE user_id = p_user_id;
  END IF;
END
$$;

-- Negocios activos del usuario de la sesión (app.user_id); para elegir negocio al iniciar sesión
CREATE FUNCTION auth.list_user_memberships()
RETURNS TABLE (membership_id uuid, organization_id uuid, organization_name text, organization_slug text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS
$$
  SELECT m.id, o.id, o.name, o.slug
  FROM core.organization_memberships m JOIN core.organizations o ON o.id = m.organization_id
  WHERE m.user_id = core.current_user_id() AND m.status = 'ACTIVE' AND o.status = 'ACTIVE'
  ORDER BY o.name
$$;

-- ── Procesos programados: negocios activos ─────────────────────────────────────
CREATE FUNCTION core.list_active_organizations()
RETURNS TABLE (organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS
$$ SELECT o.id FROM core.organizations o WHERE o.status = 'ACTIVE' ORDER BY o.created_at $$;

-- ── Propiedad y permisos ───────────────────────────────────────────────────────
ALTER FUNCTION auth.resolve_kiosk_token(text)                       OWNER TO gate_owner;
ALTER FUNCTION auth.redeem_pairing_code(text, text, text, text)     OWNER TO gate_owner;
ALTER FUNCTION auth.get_login_record(text)                          OWNER TO gate_owner;
ALTER FUNCTION auth.record_login_result(uuid, boolean, integer, integer) OWNER TO gate_owner;
ALTER FUNCTION auth.list_user_memberships()                         OWNER TO gate_owner;
ALTER FUNCTION core.list_active_organizations()                     OWNER TO gate_owner;

REVOKE ALL ON FUNCTION auth.resolve_kiosk_token(text)                       FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.redeem_pairing_code(text, text, text, text)     FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.get_login_record(text)                          FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.record_login_result(uuid, boolean, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.list_user_memberships()                         FROM PUBLIC;
REVOKE ALL ON FUNCTION core.list_active_organizations()                     FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth.resolve_kiosk_token(text)                       TO app_user, platform_ops;
GRANT EXECUTE ON FUNCTION auth.redeem_pairing_code(text, text, text, text)     TO app_user, platform_ops;
GRANT EXECUTE ON FUNCTION auth.get_login_record(text)                          TO app_user, platform_ops;
GRANT EXECUTE ON FUNCTION auth.record_login_result(uuid, boolean, integer, integer) TO app_user, platform_ops;
GRANT EXECUTE ON FUNCTION auth.list_user_memberships()                         TO app_user, platform_ops;
GRANT EXECUTE ON FUNCTION core.list_active_organizations()                     TO app_user, platform_ops;

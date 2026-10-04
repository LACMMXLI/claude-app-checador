-- 0012 · D-80: cambio de contraseña por la propia persona (autoservicio).
-- RN-IDN-02 sigue en pie: el administrador de un negocio NO puede ver ni cambiar la contraseña de otra persona. Aquí
-- solo la propia persona, probando su contraseña actual, cambia su contraseña global. `app_user` sigue sin ningún
-- privilegio sobre `auth.user_credentials`: el único camino es esta función-puerta.
--
--  * compare-and-set: el cambio solo se aplica si el hash guardado sigue siendo el que el servicio verificó (un cambio
--    concurrente o una función llamada sin verificar no puede pisarlo en silencio);
--  * revoca TODAS las demás sesiones de la persona (la actual se conserva): si alguien más tenía su sesión, la pierde;
--  * limpia el bloqueo por intentos fallidos;
--  * audita en la bitácora de CADA negocio donde la persona tiene una membresía activa, en la misma transacción, sin la
--    contraseña ni su hash.
CREATE FUNCTION auth.change_password(p_user_id uuid, p_old_hash text, p_new_hash text, p_keep_session_hash text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS
$$
DECLARE
  v_revoked integer;
  m record;
BEGIN
  UPDATE auth.user_credentials
     SET password_hash = p_new_hash, password_changed_at = now(), failed_attempts = 0, locked_until = NULL
   WHERE user_id = p_user_id AND password_hash = p_old_hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PASSWORD_CHANGED_CONCURRENTLY';
  END IF;
  UPDATE auth.sessions SET revoked_at = now()
   WHERE user_id = p_user_id AND revoked_at IS NULL AND token_hash <> coalesce(p_keep_session_hash, '');
  GET DIAGNOSTICS v_revoked = ROW_COUNT;
  FOR m IN SELECT organization_id FROM core.organization_memberships WHERE user_id = p_user_id AND status = 'ACTIVE' LOOP
    INSERT INTO audit.audit_log (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, after)
    VALUES (m.organization_id, 'USER', p_user_id, 'user.password_changed', 'user', p_user_id::text,
            jsonb_build_object('otherSessionsRevoked', v_revoked));
  END LOOP;
  RETURN v_revoked;
END
$$;

ALTER FUNCTION auth.change_password(uuid, text, text, text) OWNER TO gate_owner;
REVOKE ALL ON FUNCTION auth.change_password(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.change_password(uuid, text, text, text) TO app_user;

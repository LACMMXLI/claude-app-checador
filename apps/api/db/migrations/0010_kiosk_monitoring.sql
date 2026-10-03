-- 0010 · Fase 4 (D-76): control de kioscos — fecha de activación, último uso e IP. La revocación ya es inmediata porque
-- cada petición del dispositivo valida su credencial contra la base de datos (la cookie larga no da acceso por sí sola).

ALTER TABLE core.kiosk_devices
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN last_seen_ip text CHECK (last_seen_ip IS NULL OR length(last_seen_ip) <= 64);

-- Kioscos que ya se usaron antes de esta fase: su activación es la emisión de su credencial vigente.
ALTER TABLE core.kiosk_devices NO FORCE ROW LEVEL SECURITY;
UPDATE core.kiosk_devices SET activated_at = token_issued_at WHERE last_seen_at IS NOT NULL AND token_issued_at IS NOT NULL;
ALTER TABLE core.kiosk_devices FORCE ROW LEVEL SECURITY;

-- Canjear un código de emparejamiento ACTIVA el dispositivo (misma lógica que en 0006, ahora con activated_at).
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
  INSERT INTO core.kiosk_devices (organization_id, branch_id, name, token_prefix, token_hash, token_issued_at, activated_at)
  VALUES (v_code.organization_id, v_code.branch_id, p_name, p_prefix, p_token_hash, now(), now())
  RETURNING id INTO v_device;
  INSERT INTO audit.audit_log (organization_id, branch_id, actor_type, actor_device_id, action, entity_type, entity_id, after)
  VALUES (v_code.organization_id, v_code.branch_id, 'KIOSK', v_device, 'kiosk.paired', 'kiosk_device', v_device::text,
          jsonb_build_object('name', p_name));
  RETURN QUERY SELECT v_device, v_code.organization_id, v_code.branch_id;
END
$$;

-- 0003 · Identidad global, membresías, roles y alcance por sucursal.

-- ── auth.users: identidad GLOBAL (pertenece a la plataforma) ───────────────────
CREATE TABLE auth.users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON auth.users (email);
CREATE TRIGGER users_updated BEFORE UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- ── auth.user_credentials: SOLO plataforma / funciones-puerta ──────────────────
CREATE TABLE auth.user_credentials (
  user_id             uuid PRIMARY KEY REFERENCES auth.users (id),
  password_hash       text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts     integer NOT NULL DEFAULT 0,
  locked_until        timestamptz
);

-- ── Catálogo global de permisos ────────────────────────────────────────────────
CREATE TABLE core.permissions (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z]+(\.[a-z_]+)+$'),
  description text NOT NULL
);
INSERT INTO core.permissions (code, description) VALUES
  ('organization.manage',          'Editar datos del negocio (nombre, marca, zona horaria)'),
  ('branches.manage',              'Crear y editar sucursales'),
  ('employees.view',               'Ver empleados'),
  ('employees.manage',             'Alta, edición, baja y asignaciones de empleados'),
  ('employees.pin.manage',         'Generar o restablecer el PIN de un empleado'),
  ('schedules.manage',             'Programar y publicar horarios'),
  ('attendance.view',              'Ver asistencia, tablero e incidencias'),
  ('attendance.correction.apply',  'Aplicar correcciones de asistencia directamente'),
  ('attendance.correction.request','Solicitar correcciones (requiere aprobación)'),
  ('incidents.resolve',            'Resolver o justificar incidencias'),
  ('reports.view',                 'Consultar reportes'),
  ('reports.export',               'Exportar reportes'),
  ('audit.view',                   'Consultar la auditoría del negocio'),
  ('settings.manage',              'Configurar políticas del negocio, sucursales y empleados'),
  ('kiosks.manage',                'Emparejar y revocar kioscos'),
  ('memberships.manage',           'Activar, desactivar o quitar membresías'),
  ('roles.manage',                 'Administrar roles, permisos y alcance');
REVOKE INSERT, UPDATE ON core.permissions FROM app_user;

-- ── roles ──────────────────────────────────────────────────────────────────────
CREATE TABLE core.roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  name            text NOT NULL CHECK (length(btrim(name)) > 0),
  is_system       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name)
);
CREATE TRIGGER roles_updated BEFORE UPDATE ON core.roles FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT core.enable_tenant_rls('core.roles');

CREATE TABLE core.role_permissions (
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  role_id         uuid NOT NULL,
  permission_code text NOT NULL REFERENCES core.permissions (code),
  PRIMARY KEY (role_id, permission_code),
  FOREIGN KEY (organization_id, role_id) REFERENCES core.roles (organization_id, id)
);
SELECT core.enable_tenant_rls('core.role_permissions');
GRANT DELETE ON core.role_permissions TO app_user;   -- tabla puente de permisos (auditada)

-- ── membresías: usuario global ↔ negocio ───────────────────────────────────────
CREATE TABLE core.organization_memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  user_id         uuid NOT NULL REFERENCES auth.users (id),
  employee_id     uuid,                                  -- ficha de empleado OPCIONAL (D-15)
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'REMOVED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, user_id),
  FOREIGN KEY (organization_id, employee_id) REFERENCES core.employees (organization_id, id)
);
CREATE UNIQUE INDEX membership_employee_unique ON core.organization_memberships (organization_id, employee_id)
  WHERE employee_id IS NOT NULL;
CREATE INDEX memberships_by_user ON core.organization_memberships (user_id);
CREATE TRIGGER memberships_updated BEFORE UPDATE ON core.organization_memberships
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
SELECT core.enable_tenant_rls('core.organization_memberships');
-- El usuario autenticado puede listar SUS propias membresías ÚNICAMENTE mientras NO hay negocio
-- seleccionado (selección de negocio al iniciar sesión). Con un negocio activo solo rige tenant_isolation:
-- así una consulta con contexto de negocio nunca "ve" membresías del mismo usuario en otros negocios.
CREATE POLICY own_memberships ON core.organization_memberships FOR SELECT
  USING (user_id = core.current_user_id() AND core.current_org() IS NULL);

-- ── Asignación de roles con alcance (todas las sucursales o una lista) ─────────
CREATE TABLE core.role_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  membership_id   uuid NOT NULL,
  role_id         uuid NOT NULL,
  scope           text NOT NULL CHECK (scope IN ('ORGANIZATION', 'BRANCHES')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, membership_id) REFERENCES core.organization_memberships (organization_id, id),
  FOREIGN KEY (organization_id, role_id)       REFERENCES core.roles (organization_id, id)
);
CREATE INDEX role_assignments_by_membership ON core.role_assignments (organization_id, membership_id);
SELECT core.enable_tenant_rls('core.role_assignments');
GRANT DELETE ON core.role_assignments TO app_user;   -- revocar un rol (auditado)

CREATE TABLE core.role_assignment_branches (
  organization_id uuid NOT NULL REFERENCES core.organizations (id),
  assignment_id   uuid NOT NULL,
  branch_id       uuid NOT NULL,
  PRIMARY KEY (assignment_id, branch_id),
  FOREIGN KEY (organization_id, assignment_id) REFERENCES core.role_assignments (organization_id, id),
  FOREIGN KEY (organization_id, branch_id)     REFERENCES core.branches (organization_id, id)
);
SELECT core.enable_tenant_rls('core.role_assignment_branches');
GRANT DELETE ON core.role_assignment_branches TO app_user;   -- quitar una sucursal del alcance (auditado)

-- ── auth.users: política propia (miembro del negocio activo o la propia sesión) ─
ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.users FORCE ROW LEVEL SECURITY;
CREATE POLICY member_or_self ON auth.users FOR SELECT
  USING (id = core.current_user_id() OR EXISTS (
    SELECT 1 FROM core.organization_memberships m
    WHERE m.user_id = users.id AND m.organization_id = core.current_org()));
-- La API solo LEE identidades; nunca las crea ni modifica. Credenciales: sin acceso alguno.
GRANT SELECT ON auth.users TO app_user;
REVOKE ALL ON auth.user_credentials FROM app_user;

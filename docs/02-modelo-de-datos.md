# 02 · Modelo de datos (PostgreSQL) — multi-negocio

> **Versión 1.3 — CONGELADA.** Deriva de `01-reglas-de-negocio.md`.
> Estado de implementación: **Fases 0 a 3 implementadas** (esquemas `platform`, `auth`, `core`, `audit`, `scheduling`, `attendance`; migraciones `0001`–`0008` en `apps/api/db/migrations`).

## 1. Convenciones

- **Claves:** `uuid` (`gen_random_uuid()`). Sin enteros autoincrementales expuestos.
- **Tiempo:** todo instante es `timestamptz` y se guarda en **UTC**. Un invariante verificado en CI: no existe ninguna columna `timestamp without time zone`. Las fechas laborales son `date` calculadas con la zona efectiva de la sucursal.
- **Nada se borra:** FKs `ON DELETE RESTRICT`; el rol de la aplicación **no tiene `DELETE`** sobre tablas de negocio (excepción documentada: tablas puente de permisos/alcance).
- **Esquemas:** `platform`, `auth`, `core`, `audit` (Fase 0) · `scheduling`, `attendance` (fases 2–3) · futuros módulos con su propio esquema.
- **SQL es la fuente de verdad** (migraciones `.sql` versionadas). Drizzle ORM se usa para consultas tipadas; RLS, constraints, índices, triggers y exclusiones forman parte del diseño oficial en PostgreSQL.
- **Multi-tenant:** toda tabla de datos de negocio tiene `organization_id uuid NOT NULL`, `UNIQUE (organization_id, id)`, FKs **compuestas** hacia sus padres y **RLS habilitado y forzado** (§3).
- **Excepciones registradas** (no llevan `organization_id`): `core.permissions` (catálogo), `core.organizations` (es el tenant), `core.tenant_exempt_tables`, esquemas `platform` y `auth` (globales con protección propia), `public.schema_migrations`. Toda excepción está en `core.tenant_exempt_tables` con su motivo; **cualquier otra tabla sin protección rompe CI**.

## 2. Diagrama (Fase 0)

```mermaid
erDiagram
  organizations ||--o{ branches : ""
  organizations ||--o{ employees : ""
  organizations ||--o{ organization_memberships : ""
  users ||--|| user_credentials : "credenciales (solo plataforma)"
  users ||--o{ organization_memberships : "pertenece"
  organization_memberships }o--o| employees : "ficha opcional"
  organization_memberships ||--o{ role_assignments : ""
  roles ||--o{ role_assignments : ""
  roles ||--o{ role_permissions : ""
  permissions ||--o{ role_permissions : ""
  role_assignments ||--o{ role_assignment_branches : "alcance"
  branches ||--o{ role_assignment_branches : ""
  employees ||--o{ employee_branch_assignments : ""
  branches ||--o{ employee_branch_assignments : ""
  branches ||--o{ kiosk_devices : ""
  branches ||--o{ kiosk_pairing_codes : ""
  organizations ||--o{ policy_overrides : "overrides"
  branches ||--o{ policy_overrides : ""
  employees ||--o{ policy_overrides : ""
  organizations ||--o{ audit_log : ""
```
*Toda tabla de negocio cuelga además de `organizations` por `organization_id`. `platform.policy_defaults` (política de plataforma, singleton) y `platform.platform_audit_log` son globales.*

## 3. Aislamiento entre negocios

### 3.1 FKs compuestas
```sql
ALTER TABLE core.branches ADD CONSTRAINT branches_org_id_uk UNIQUE (organization_id, id);
-- en el hijo: la FK incluye organization_id ⇒ imposible apuntar a otro negocio
ALTER TABLE core.employee_branch_assignments
  ADD FOREIGN KEY (organization_id, branch_id) REFERENCES core.branches (organization_id, id);
```

### 3.2 RLS forzado
```sql
CREATE FUNCTION core.current_org() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.organization_id', true), '')::uuid $$;

SELECT core.enable_tenant_rls('core.branches');
-- = ENABLE + FORCE ROW LEVEL SECURITY + política:
--   USING (organization_id = core.current_org()) WITH CHECK (organization_id = core.current_org())
```
- Cada transacción de la API fija `set_config('app.organization_id', …, true)` (alcance de transacción: no se filtra entre peticiones del pool). **Sin contexto ⇒ 0 filas** (falla cerrado).
- `WITH CHECK` impide insertar o **mover** filas a otro negocio.

### 3.3 Roles de PostgreSQL
| Rol | Uso | Atributos |
|---|---|---|
| `migrator` | Dueño de los objetos; ejecuta migraciones | No superusuario, **sin `BYPASSRLS`** |
| `app_user` | La API | `NOSUPERUSER NOBYPASSRLS`; DML sin `DELETE` en negocio; sin `UPDATE`/`DELETE`/`TRUNCATE` en tablas solo-agregar |
| `platform_ops` | CLI de plataforma (alta de negocios, restablecer contraseñas) | `BYPASSRLS`; credenciales fuera de la API |
| `gate_owner` | Dueño de las funciones-puerta (`NOLOGIN`) | `BYPASSRLS`; privilegios mínimos |

Los roles los crea un script de **bootstrap** ejecutado una vez con superusuario.

### 3.4 Funciones-puerta (`SECURITY DEFINER`, dueño `gate_owner`, `search_path` fijo)
Necesarias porque ciertas búsquedas ocurren **antes** de conocer el negocio:
- `auth.resolve_kiosk_token(prefix)` → `(device_id, organization_id, branch_id, token_hash, status)`.
- `auth.redeem_pairing_code(code_hash, device_name, token_prefix, token_hash)` → crea el dispositivo (código de un solo uso).
- `auth.get_login_record(email)` → usuario + hash de contraseña + membresías activas (único camino a las credenciales).
- `core.list_active_organizations()` → ids, para procesos programados.

### 3.5 Verificación automática en CI
`core.tenant_isolation_violations()` revisa el catálogo y devuelve un renglón por violación:
- tabla con `organization_id` **sin** RLS habilitado, **sin** `FORCE`, **sin** política que use `core.current_org()`, o con `organization_id` nullable;
- tabla en un esquema de negocio **sin** `organization_id` que no esté en `core.tenant_exempt_tables`;
- columnas `timestamp without time zone`.

`pnpm check:tenancy` falla (exit ≠ 0) si hay violaciones; además una prueba demuestra que **una tabla multi-tenant nueva sin protección es detectada**.

## 4. Esquemas `platform` y `auth` (globales)

### `platform.policy_defaults` (singleton)
Política de **nivel plataforma**: una columna tipada por parámetro, todas `NOT NULL` (ver §6). Fila única (`id boolean PRIMARY KEY DEFAULT true CHECK (id)`).

### `platform.platform_audit_log` (solo-agregar)
Operaciones de plataforma: alta/suspensión de negocio, restablecimiento de contraseñas, alta de usuarios. `id`, `occurred_at`, `actor`, `action`, `organization_id` (nullable, sin FK para no bloquear), `details` jsonb.

### `auth.users` (identidad global)
`id`, `email` (único, minúsculas), `display_name`, `status` (`ACTIVE`/`DISABLED`; lo gestiona la plataforma), `created_at`, `updated_at`.
**RLS especial:** un usuario es visible solo si es miembro del negocio activo (`EXISTS` en `organization_memberships`) o es el usuario de la sesión. El administrador de un negocio **no ve a usuarios de otros negocios**.

### `auth.sessions` (Fase 1)
`id`, `token_hash` (SHA-256 del identificador que viaja en la cookie; **nunca** el identificador), `user_id`, `organization_id` + `membership_id` (negocio activo; ambos nulos hasta elegir), `created_at`, `last_seen_at`, `expires_at`, `revoked_at`, `ip`, `user_agent`. FK compuesta a la membresía. **RLS forzado sin políticas y sin privilegios para `app_user`:** solo se usa por funciones-puerta (`create_session`, `resolve_session`, `switch_session_organization`, `revoke_session`). Cambiar de negocio revoca la fila y crea otra (rotación).

### `auth.user_credentials`
`user_id` (PK), `password_hash` (argon2id), `password_changed_at`, `failed_attempts`, `locked_until`.
**`app_user` no tiene ningún privilegio sobre esta tabla.** La API accede solo vía funciones-puerta; un administrador de negocio no puede leer ni cambiar la contraseña global. El restablecimiento lo hace `platform_ops` (CLI). *(Recuperación por correo: fase posterior; el modelo ya separa credenciales.)*

## 5. Esquema `core`

### `core.organizations` (el tenant)
`id` (= `organization_id` en todo el sistema), `slug` (único), `name`, **`timezone` NOT NULL** (IANA, sin default; validada por trigger contra `pg_timezone_names`), `branding` jsonb, `status` (`ACTIVE`/`SUSPENDED`), `created_at`, `updated_at`.
RLS: `id = core.current_org()`. `app_user`: `SELECT` y `UPDATE (name, branding, timezone)`; crear negocios solo `platform_ops`. Fatboy: `timezone = 'America/Tijuana'`.

### `core.branches`
`id`, `organization_id`, `code`, `name`, **`timezone` NULL** (hereda del negocio; si se define, la sobrescribe; validada igual), `is_active`. `UNIQUE (organization_id, code)`, `UNIQUE (organization_id, id)`.
Zona efectiva = `COALESCE(branches.timezone, organizations.timezone)`.

### `core.employees`
`id`, `organization_id`, `employee_number` (`UNIQUE (organization_id, employee_number)`), `first_name`, `last_name`, `phone`, `notes`, `status` (`ACTIVE`/`INACTIVE`), `hired_at`, `terminated_at`, `termination_reason`, `pin_hash`, `pin_set_at`.
```sql
-- PIN único entre ACTIVOS del mismo negocio (el mismo PIN en otro negocio es válido)
CREATE UNIQUE INDEX employees_pin_unique ON core.employees (organization_id, pin_hash)
  WHERE status = 'ACTIVE' AND pin_hash IS NOT NULL;
CHECK (status = 'ACTIVE' OR pin_hash IS NULL)   -- la baja invalida el PIN
```
`pin_hash = HMAC-SHA256(PEPPER, organization_id ‖ ':' ‖ pin)` en hex. **Nunca el PIN.** El *pepper* vive fuera de la BD; al mezclar `organization_id`, dos negocios con el mismo PIN producen hashes distintos. Restablecer = sobrescribir `pin_hash` (el anterior deja de funcionar al instante).

### `core.employee_branch_assignments`
`id`, `organization_id`, `employee_id`, `branch_id`, `kind` (`PRIMARY`/`TEMPORARY`), `valid_from`, `valid_to`, `reason`, `created_by`. FKs compuestas.
```sql
EXCLUDE USING gist (employee_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&) WHERE (kind = 'PRIMARY')
CHECK (valid_to IS NULL OR valid_to >= valid_from)
```

### Membresías, roles y alcance
- **`core.organization_memberships`**: `id`, `organization_id`, `user_id` → `auth.users`, `employee_id` (nullable: **ficha opcional**), `status` (`ACTIVE`/`INACTIVE`/`REMOVED`). `UNIQUE (organization_id, user_id)`; `UNIQUE (organization_id, employee_id) WHERE employee_id IS NOT NULL`. Política adicional de **solo lectura**: `user_id = core.current_user_id()` (el usuario lista sus propios negocios al iniciar sesión).
- **`core.permissions`** *(global)*: `code` PK, `description`. Catálogo sembrado.
- **`core.roles`**: `id`, `organization_id`, `name`, `is_system`. Se siembran `ADMIN` y `ENCARGADO` al crear el negocio.
- **`core.role_permissions`**: `organization_id`, `role_id`, `permission_code`.
- **`core.role_assignments`**: `id`, `organization_id`, `membership_id`, `role_id`, `scope` (`ORGANIZATION` / `BRANCHES`).
- **`core.role_assignment_branches`**: `organization_id`, `assignment_id`, `branch_id`. Con `scope = 'BRANCHES'` exige ≥ 1 fila (validado en servicio).

Un usuario con varias sucursales = **una cuenta, una membresía, una asignación con varias filas de alcance**.

### `core.kiosk_devices` y `core.kiosk_pairing_codes`
- `kiosk_devices`: `id` (= `device_id`), `organization_id`, `branch_id`, `name`, `status` (`ACTIVE`/`INACTIVE`, del dispositivo) y su token por separado: `token_prefix` (único global), `token_hash` (SHA-256 del secreto; nunca el token), `token_issued_at`, `token_revoked_at` (prefijo y hash ambos nulos = sin token), `last_seen_at`. **El token pertenece a `organization_id + branch_id + device_id`**; regenerar lo reemplaza y el anterior deja de funcionar. **Activar** un navegador como kiosco (D-56) también lo rota: el token pegado es de un solo uso y la credencial nueva solo vive en una cookie `HttpOnly`.
- `kiosk_pairing_codes`: `id`, `organization_id`, `branch_id`, `code_hash`, `expires_at`, `used_at`, `created_by`. Un solo uso, vencimiento corto.

### `core.invitations` (Fase 1)
`id`, `organization_id`, `email`, `role_id` (FK compuesta), `scope`, `branch_ids` (uuid[]), `token_hash` (único; nunca el token), `expires_at`, `accepted_at`, `accepted_user_id`, `revoked_at`, `created_by`. RLS por negocio. Se acepta por la función-puerta `auth.accept_invitation` (uso único, atómica): crea la identidad solo si no existe, la membresía y la asignación de rol (las sucursales deben ser del mismo negocio por FK compuesta) y audita.

### `core.pin_attempts`
`id`, `organization_id`, `device_id`, `attempted_at`, `success`, `employee_id` (null si falló). Alimenta el bloqueo `pin_max_attempts`/`pin_lockout_sec`. **No guarda el PIN intentado.**

### `core.policy_overrides` (D-20: solo overrides)
`id`, `organization_id`, `scope` (`ORGANIZATION`/`BRANCH`/`EMPLOYEE`), `branch_id`, `employee_id`, **una columna tipada por parámetro, todas nullable** (`NULL` = hereda), `updated_by`, `created_at`, `updated_at`.
```sql
CHECK ((scope='ORGANIZATION' AND branch_id IS NULL AND employee_id IS NULL)
    OR (scope='BRANCH'       AND branch_id IS NOT NULL AND employee_id IS NULL)
    OR (scope='EMPLOYEE'     AND employee_id IS NOT NULL AND branch_id IS NULL))
-- niveles permitidos por parámetro, p. ej. no se puede sobrescribir por empleado:
CHECK (scope <> 'EMPLOYEE' OR (early_entry_window_min IS NULL AND absent_after_min IS NULL
       AND operational_cutoff IS NULL AND max_open_session_minutes IS NULL AND debounce_sec IS NULL
       AND pin_max_attempts IS NULL AND pin_lockout_sec IS NULL AND week_start_day IS NULL))
CHECK (scope = 'ORGANIZATION' OR week_start_day IS NULL)
-- un override por nivel:
UNIQUE (organization_id) WHERE scope='ORGANIZATION'
UNIQUE (organization_id, branch_id) WHERE scope='BRANCH'
UNIQUE (organization_id, employee_id) WHERE scope='EMPLOYEE'
```
Más rangos por parámetro (`CHECK (break_allowed_min BETWEEN 0 AND 600)`, `week_start_day BETWEEN 1 AND 7`, etc.).

**Política efectiva** (`resolveEffectivePolicy`, función pura con pruebas): `plataforma → ORGANIZATION → BRANCH → EMPLOYEE`, campo por campo (`COALESCE` en orden inverso). Ejemplo: plataforma 35 · Fatboy (sin override) 35 · San Marcos 35 · Venecia 40 · empleado X (override 30) ⇒ efectivo de X = 30.

Parámetros: `entry_tolerance_min`, `exit_tolerance_min`, `max_breaks`, `break_allowed_min`, `break_tolerance_min`, `require_break`, `early_entry_window_min`, `absent_after_min`, `operational_cutoff`, `max_open_session_minutes` (antes `max_hours_unscheduled`, renombrado por D-48), `debounce_sec`, `pin_max_attempts`, `pin_lockout_sec`, `pin_lockout_max_sec`, `week_start_day`, `shift_min_minutes`, `shift_max_minutes` (tabla de defaults y niveles en `01 §10`).

## 6. Esquema `audit`

### `audit.audit_log` (solo-agregar, por negocio)
`id` (bigint identity), `organization_id` NOT NULL, `branch_id` (nullable: solo si la acción pertenece a una sucursal), `occurred_at`, `actor_type` (`USER`/`SYSTEM`/`KIOSK`), `actor_user_id`, `actor_device_id`, `action`, `entity_type`, `entity_id`, `before` jsonb, `after` jsonb, `reason`, `ip`, `request_id`.
- RLS por negocio; `INSERT` solo con su contexto (`WITH CHECK`).
- Se inserta **en la misma transacción** del cambio auditado.
- Trigger que rechaza `UPDATE`/`DELETE`/`TRUNCATE` + `REVOKE` para `app_user`.
- **Nunca** contiene PIN, hash de PIN, contraseñas ni tokens (el servicio redacta campos sensibles y hay pruebas).

## 7. Esquema `scheduling` (Fase 2 — implementado)

Todas con `organization_id NOT NULL`, FKs compuestas y RLS forzado.

### `weekly_schedules` — horario semanal (planificación)
`id`, `organization_id`, `branch_id`, `week_start`, `status` (`DRAFT`/`PUBLISHED`), `version` (concurrencia optimista), `published_at`, `published_by`, `created_by`. `UNIQUE (organization_id, branch_id, week_start)`, `UNIQUE (organization_id, id, branch_id)` (para la FK del turno). Trigger: un horario publicado **no vuelve** a borrador.

### `shifts` — turno concreto (fuente de verdad para asistencia)
| Columna | Notas |
|---|---|
| `id`, `organization_id`, `schedule_id`, `branch_id`, `employee_id` | FK `(organization_id, schedule_id, branch_id)` → horario: la sucursal del turno es la de su horario; FKs compuestas a sucursal y empleado del mismo negocio |
| `business_date` | fecha local en que **inicia** (cuadrícula semanal) |
| `starts_at`, `ends_at` | UTC; `CHECK (ends_at > starts_at)`, `≤ 24 h` |
| `timezone_snapshot` | zona IANA usada al crearlo (validada) |
| `scheduled_minutes` | **columna generada** de los instantes (sin duplicar datos; no descuenta comida) |
| `status` | `SCHEDULED` / `CANCELLED` (+ `cancelled_at`, `cancelled_by`, `cancel_reason` obligatorio) |
| `notes`, `source` (`MANUAL`/`COPY`/`TEMPLATE`), `source_shift_id`, `source_template_id` | origen (solo referencia) |
| `version`, `created_by`, `updated_by`, timestamps | concurrencia optimista y trazabilidad |
```sql
CONSTRAINT shift_no_overlap EXCLUDE USING gist (employee_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (status = 'SCHEDULED')                         -- D-29, entre sucursales, [inicio, fin)
UNIQUE (organization_id, schedule_id, source_shift_id) WHERE source_shift_id IS NOT NULL AND status = 'SCHEDULED'  -- copiar es idempotente
```
Triggers: un turno **cancelado queda congelado**; **solo se borra** un turno de un horario en `DRAFT` (nunca publicado).

### `schedule_templates` / `schedule_template_entries` — plantillas (D-23)
Plantilla por sucursal (`name` único por sucursal, `is_active`, `version`) y entradas `employee_id`, `weekday` (ISO 1–7), `start_local`, `end_local` (fin ≤ inicio ⇒ día siguiente). Generar desde una plantilla **copia** valores a turnos nuevos; editarla no toca turnos.

### Permisos nuevos
`schedules.view`, `schedules.history.manage` (corregir turnos en curso/terminados, con motivo), `schedules.templates.manage`. ADMIN: todos. ENCARGADO por defecto: `schedules.view` y `schedules.manage` (siempre dentro de su alcance; revocable).

## 8. Esquema `attendance` (Fase 3 — implementado, migración `0008`)

Todas con `organization_id NOT NULL`, `UNIQUE (organization_id, id)`, FKs compuestas y RLS forzado. `app_user` **sin `DELETE`** y con `UPDATE` solo en columnas que cambian por reglas de dominio; `platform_ops` solo lectura.
*Ajuste 1.3 (D-37, D-52): el diseño 1.2 (`attendance_records` con valores calculados guardados, `punch_events` + `punch_event_voids`) se sustituyó por valores EFECTIVOS en la jornada, eventos físicos aparte y correcciones solo-agregar. Las diferencias y duraciones se calculan.*

### `work_sessions` — jornada real (D-37)
| Columna | Notas |
|---|---|
| `branch_id` | donde **realmente** ocurrió (D-36) |
| `employee_id`, `shift_id` (nullable, D-6) | FK `(organization_id, shift_id, employee_id, branch_id)` → `shifts`: solo un turno del **mismo** empleado y sucursal |
| `operational_date` | D-46 |
| `started_at`, `ended_at` | instantes **efectivos** (tras correcciones); `ended_at` nunca se inventa |
| `status` | `OPEN` / `REVIEW` (requiere corrección, sin salida) / `CLOSED`; `CHECK (status = 'CLOSED') = (ended_at IS NOT NULL)` |
| `origin` | `KIOSK` / `CORRECTION` |
| `policy_snapshot` | política efectiva usada (tolerancia, ventana, corte, pausas, límite de jornada abierta) — RN-CAL-05 |
| `version`, `created_by`, timestamps | concurrencia optimista (cada checada y corrección la incrementa) |
```sql
CREATE UNIQUE INDEX work_sessions_one_open ON attendance.work_sessions (organization_id, employee_id) WHERE status = 'OPEN';     -- D-40
CREATE UNIQUE INDEX work_sessions_one_per_shift ON attendance.work_sessions (organization_id, shift_id) WHERE shift_id IS NOT NULL;
EXCLUDE USING gist (employee_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&) WHERE (ended_at IS NOT NULL)            -- jornadas cerradas no se cruzan
```
Trigger `guard_work_session`: solo se liga a turnos **oficiales** (`SCHEDULED` + horario `PUBLISHED`); no se cierra con una pausa abierta; una jornada cerrada no se reabre. Trigger en `shifts`: un turno con jornada no se cancela.

### `events` — checadas físicas (INMUTABLES, D-12/D-38)
`branch_id` (sucursal del kiosco), `employee_id`, `work_session_id`, `break_id` (en pausas), `type` (`CLOCK_IN`/`BREAK_START`/`BREAK_END`/`CLOCK_OUT`), **`client_event_id`**, **`device_id`**, **`occurred_at`** (hora del servidor en línea), **`received_at`**, **`source`** (`KIOSK_ONLINE`/`KIOSK_OFFLINE_SYNC`), `time_source` (`SERVER`/`DEVICE`).
```sql
CONSTRAINT events_idempotency UNIQUE (organization_id, device_id, client_event_id)   -- D-54
-- trigger forbid_mutation (UPDATE/DELETE/TRUNCATE) + sin privilegios
```

### `breaks` — pausas (D-14, D-49)
`work_session_id`, `sequence`, `started_at`, `ended_at` (nunca se inventa, D-50), `allowed_minutes` y `tolerance_minutes` (copia de la política), **`duration_minutes`** y **`exceeded_minutes`** = columnas **generadas** (minutos con segundos truncados), `origin`, `version`. `UNIQUE (organization_id, work_session_id, sequence)`; una sola pausa abierta por jornada. `max_breaks` vive en la política: 2 pausas no requieren migración.

### `incidents`
`branch_id`, `employee_id`, `work_session_id` (nullable), `shift_id` (nullable; la `FALTA` no tiene jornada), `operational_date`, `type` (ver RN-INC-01), `status` (`OPEN`/`RESOLVED`), `details`, `detected_by` (`KIOSK`/`RECONCILER`/`CORRECTION`), `resolution` (`CORRECTED`/`JUSTIFIED`/`CONFIRMED`/`DISMISSED`) + `resolved_at`, `resolved_by`, `resolution_reason` (obligatorio), `resolution_correction_id`.
```sql
UNIQUE (organization_id, work_session_id, type) WHERE work_session_id IS NOT NULL AND status = 'OPEN'
UNIQUE (organization_id, shift_id) WHERE type = 'FALTA'          -- una falta por turno, aunque se resuelva (D-44)
-- trigger: una incidencia resuelta no se modifica
```

### `corrections` — correcciones (solo-agregar, D-51/D-52/D-53)
`branch_id` (donde ocurrió la jornada), `employee_id`, `work_session_id`, `break_id`, `incident_id`, `action` (`CREATE_SESSION`, `SET_CLOCK_IN`, `SET_CLOCK_OUT`, `SET_BREAK_START`, `SET_BREAK_END`, `LINK_SHIFT`, `UNLINK_SHIFT`), `original_value`, `corrected_value`, `before`/`after` (jornada completa), `reason` (`CHECK` no vacío), `corrected_by`, `corrected_at`. Trigger: **nadie corrige su propia jornada** (la membresía del corrector ligada a esa ficha de empleado ⇒ rechazo).

### Valores derivados (se calculan, no se guardan)
Diferencia de llegada (D-41) y de salida (D-65), duración real (D-64), minutos y exceso acumulados de pausas, estado de llegada (D-43) y estados del tablero (D-60).

## 9. Casos difíciles

| Caso | Resolución |
|---|---|
| Fuga entre negocios | RLS forzado + FKs compuestas + rol sin `BYPASSRLS` + contexto obligatorio + CI |
| Zona horaria | UTC en BD; negocio con zona obligatoria; sucursal hereda o sobrescribe |
| Turno 7 PM → 3 AM | Turno guarda instantes reales; Salida va a la jornada abierta; `business_date` = día de inicio |
| Olvido de salida | primer corte tras el fin del turno ⇒ `REVIEW` + `SALIDA_OLVIDADA`; nada se inventa |
| Retardo 7:12 vs 7:00 (tol. 10) | diferencia 12 (calculada) + incidencia `RETARDO`; 7:08 ⇒ 8, sin incidencia |
| Dos pausas el día de mañana | Filas en `breaks`; `max_breaks = 2` en política; sin migración |
| Offline futuro | `client_event_id` + `device_id` + `occurred_at`/`received_at` + `source`; el reenvío es idempotente |
| Misma persona en dos negocios | Una fila en `auth.users`, dos membresías |
| Administrador intenta cambiar contraseña global | Sin privilegios sobre `auth.user_credentials` |
| Mismo PIN en dos negocios | Permitido (único por negocio; el hash incluye `organization_id`) |
| Política de empleado | Solo el override; efectivo calculado |
| Baja de empleado | `INACTIVE`, `pin_hash = NULL` (CHECK), historial intacto |

## 10. Procesos programados (Fase 3)

`ReconcilerService` (comando `node dist/src/cli/reconcile.js` o, opcionalmente, dentro de la API con `RECONCILE_INTERVAL_SEC`): por cada negocio de `core.list_active_organizations()`, en **su propio contexto** (RLS activo, rol `app_user`) y con un candado consultivo por negocio: `FALTA` para turnos oficiales terminados sin jornada; `REVIEW` + `SALIDA_OLVIDADA` al primer corte posterior al fin del turno; `REVIEW` + `JORNADA_ABIERTA_EXCEDIDA` para jornadas sin turno abiertas más de `max_open_session_minutes`; `REGRESO_COMIDA_FALTANTE` si la pausa seguía abierta. Idempotente (índices únicos + actualizaciones condicionadas). La misma revisión se hace al identificarse el empleado.

## 11. Volumen

~50 empleados × 2–4 checadas/día ≈ 70 mil filas/año por negocio pequeño. Todos los índices empiezan por `organization_id`. Un negocio muy grande podría moverse a su propia base sin cambiar el modelo.

# 04 · Operación (Fase 0)

## 1. Desarrollo local

Requisitos: Node 22, pnpm 10, PostgreSQL 16 (o `docker compose -f docker-compose.dev.yml up -d`).

```bash
pnpm install
pnpm typecheck && pnpm build
pnpm test        # crea la BD `checador_test`, los roles, aplica TODAS las migraciones y ejecuta las pruebas
```
Variables de las pruebas (valores por defecto entre paréntesis): `TEST_PG_HOST` (127.0.0.1), `TEST_PG_PORT` (5432), `TEST_PG_SUPERUSER` (postgres), `TEST_PG_SUPERPASSWORD` (postgres), `TEST_PG_DATABASE` (checador_test).

## 2. Primer despliegue en Coolify

1. Crear un recurso **Docker Compose** apuntando a este repositorio (rama de despliegue) y al archivo `docker-compose.yml`.
2. Cargar las variables de `.env.example` en Coolify (contraseñas aleatorias *sin caracteres especiales*: `openssl rand -hex 24`; `PIN_PEPPER` ≥ 32 caracteres). **Guardar `PIN_PEPPER` en un gestor de secretos**: si se pierde, hay que regenerar el PIN de todos los empleados.
3. Desplegar. El servicio `init` (una vez por despliegue, idempotente): crea/actualiza roles → aplica migraciones → ejecuta `check:tenancy`. Después arranca `api` (solo con `app_user`).
4. Crear el primer negocio (Fatboy) con el CLI de plataforma (desde la terminal de Coolify o el servidor):
   ```bash
   docker compose --profile tools run --rm platform create-organization \
     --name "Fatboy" --slug fatboy --timezone America/Tijuana \
     --branch VEN="Venecia" --branch SMA="San Marcos" --branch AME="Américas" \
     --admin-email dueno@ejemplo.com --admin-name "Nombre del dueño" --admin-password '<mínimo 10 caracteres>'
   ```
   La zona horaria es **obligatoria**; sin ella el comando falla. Las sucursales heredan la del negocio (se puede sobrescribir por sucursal después).
5. Restablecer una contraseña global (mientras no exista recuperación por correo): `... run --rm platform reset-password --email persona@ejemplo.com --password '<nueva>'`.
6. Suspender/reactivar un negocio: `... platform set-status --slug fatboy --status SUSPENDED|ACTIVE`.

## 3. Respaldos (crítico)

La base contiene a **todos** los negocios y su auditoría. Respaldos diarios de Coolify a un destino **fuera del servidor**, cifrados, con **prueba de restauración** periódica. Restringir el acceso a los respaldos.

## 4. Cómo agregar una tabla de negocio (checklist; CI lo hace cumplir)

1. Migración nueva `NNNN_nombre.sql` (nunca editar una ya aplicada: el checksum lo impide).
2. `organization_id uuid NOT NULL REFERENCES core.organizations (id)`, `UNIQUE (organization_id, id)` y **FKs compuestas** `(organization_id, x_id)` hacia sus padres.
3. `SELECT core.enable_tenant_rls('esquema.tabla');`
4. Tablas solo-agregar: trigger `core.forbid_mutation()` + `REVOKE UPDATE, DELETE, TRUNCATE`.
5. Definición en `src/db/schema/index.ts` (la prueba de deriva compara con la BD) y datos de siembra en `test/helpers/world.ts` (la prueba de aislamiento exige filas en A y B).
6. Si olvidas algo: `pnpm check:tenancy` y las pruebas fallan.

## 5. Qué NO está en la Fase 0

Login HTTP y sesión, panel, alta de usuarios por el administrador del negocio, recuperación por correo, turnos, checadas, jornadas, incidencias, correcciones, reportes, tiempo real (ver `03-arquitectura.md §10`).

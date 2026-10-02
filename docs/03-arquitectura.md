# 03 · Arquitectura

> **Versión 1.1 — CONGELADA.** Estado: **Fases 0 y 1 implementadas y probadas** (ver §10 y `04-operacion.md`). **Aún NO desplegable:** falta verificar Docker (§9). GitHub Actions ya está en verde.

## 1. Resumen

**Monolito modular multi-tenant** en TypeScript, en un monorepo (pnpm), desplegado con Docker Compose en Coolify. **Una sola base PostgreSQL y un solo esquema compartidos por todos los negocios**, aislados con `organization_id` + **Row-Level Security** y roles de BD sin `BYPASSRLS`. Fatboy es el primer negocio (tenant).

| Capa | Tecnología | Estado |
|---|---|---|
| Backend | **NestJS 11** (API REST + SSE) sobre servicios de dominio sin decoradores (testeables con PostgreSQL real) | Fase 1: autenticación, sesiones, negocio activo, RBAC y administración base |
| Base de datos | **PostgreSQL 16** — RLS, constraints, índices parciales, exclusiones (`btree_gist`), triggers | Fase 0 completa |
| Acceso a datos | **Drizzle ORM** para consultas tipadas; **migraciones SQL propias** como fuente de verdad | Fase 0 |
| Validación | **Zod** | Fase 0 |
| Frontend | **Next.js 16 + React 19**, CSS propio (sin framework visual todavía); panel funcional responsive; textos por **sistema de traducciones** (es-MX). El panel reenvía `/api/*` a la API (proxy del mismo origen) | Fase 1: panel. Kiosco visual: Fase 3 |
| Tiempo real | **SSE** | Fase 4 |
| Excel | `exceljs` | Fase 6 |
| Pruebas | Vitest + PostgreSQL real (sin mocks de BD) + Playwright (E2E del panel) | 179 pruebas + 1 E2E |
| CI | GitHub Actions: typecheck → build → migraciones desde cero → `check:tenancy` → pruebas → smoke | Fase 0 |

**Por qué NestJS y no solo rutas API de Next.js:** módulos que crecerán (mesas, adelantos, nómina, comunicados), procesos en segundo plano con scheduler, tiempo real con estado en memoria, múltiples clientes (kiosco, panel, móvil) y el **contexto de negocio** como pieza transversal y auditable.

**Por qué migraciones SQL propias con Drizzle ORM:** el diseño depende de RLS, triggers, exclusiones e índices parciales que el esquema declarativo de un ORM no representa bien. Las migraciones `.sql` son oficiales (checksum, idempotentes, aplicadas con el rol `migrator`). `test/schema-drift.test.ts` verifica que las definiciones de Drizzle coincidan con la base migrada.

## 2. Estrategia multi-tenant

### 2.1 Modelo elegido
| Opción | Aislamiento | Costo operativo | Veredicto |
|---|---|---|---|
| **BD compartida + `organization_id` + RLS** | Alto, impuesto por la BD | Bajo | ✅ **Elegida** |
| Esquema por negocio | Alto | Migraciones ×N | ❌ |
| BD por negocio | Máximo | Muy alto | ❌ ahora; posible después para un cliente grande sin cambiar el modelo |

### 2.2 Cómo viaja el negocio en cada operación
```mermaid
sequenceDiagram
  participant C as Cliente (panel / kiosco)
  participant G as Autenticación (sesión / token de kiosco)
  participant T as TenantDb
  participant DB as PostgreSQL (rol app_user, RLS)
  C->>G: cookie de sesión  |  token de kiosco
  G->>G: resuelve organization_id (+ branch_id / device_id) DESDE LA SESIÓN o el TOKEN
  G->>T: TenantContext {organizationId, actor}
  T->>DB: BEGIN; set_config('app.organization_id', id, true); ...consultas...; COMMIT
  DB-->>T: solo filas del negocio (RLS)
```
- **El `organization_id` nunca se acepta del body, query ni cabeceras del cliente** (el frontend jamás lo decide).
- `TenantDb.run(ctx, fn)` es la **única** puerta a datos de negocio. El pool crudo no lo usan los módulos (lo impone `test/architecture.test.ts` en CI). `PlatformDb` (BYPASSRLS) solo existe en el CLI.
- `set_config(..., true)` tiene alcance de transacción: **no se filtra entre peticiones** del pool (hay prueba con `max = 1`). Sin contexto ⇒ 0 filas (falla cerrado).

### 2.3 Capas de defensa
1. **Backend:** autenticación, permisos + alcance de sucursal en cada consulta.
2. **Acceso a datos:** contexto obligatorio; los servicios usan `ctx.organizationId`, nunca datos del cliente.
3. **PostgreSQL:** FKs compuestas `(organization_id, id)` + RLS `FORCE` con `core.current_org()` + rol `app_user` `NOBYPASSRLS`. Una **verificación de catálogo** (`core.tenant_isolation_violations()`) y **pruebas A↔B de lectura y escritura sobre cada tabla** corren en CI; una tabla nueva sin protección **rompe el pipeline** (probado).

### 2.4 Roles de PostgreSQL
`migrator` (dueño, DDL) · `app_user` (la API: DML sin `DELETE` en datos de negocio, sin acceso a credenciales) · `platform_ops` (CLI, `BYPASSRLS`) · `gate_owner` (dueño de las funciones-puerta, `NOLOGIN`, `BYPASSRLS`). Los crea un **bootstrap** con superusuario (idempotente).

### 2.5 Funciones-puerta
Lo único que ocurre antes de conocer el negocio: `auth.resolve_kiosk_token`, `auth.redeem_pairing_code`, `auth.get_login_record`, `auth.record_login_result`, `auth.list_user_memberships`, `core.list_active_organizations`. `SECURITY DEFINER`, `search_path` fijo, `EXECUTE` solo para `app_user`/`platform_ops`.

### 2.6 Identidad, sesión y negocio activo
- **Identidad y credenciales pertenecen a la plataforma** (`auth.users` + `auth.user_credentials`). `app_user` **no tiene ningún privilegio** sobre las credenciales: el administrador de un negocio no puede verlas ni cambiarlas (hay pruebas). Restablecer una contraseña global lo hace la plataforma por CLI; la **recuperación por correo** queda preparada (tabla de credenciales separada) para una fase posterior.
- Login: correo + contraseña (argon2id). Si el usuario tiene un negocio activo entra directo; si tiene varios, **elige negocio**. La sesión queda **ligada a un solo negocio**.
- Membresía = usuario ↔ negocio; **ficha de empleado opcional**. Alcance por asignación de rol (todas las sucursales o lista).

### 2.6.1 Sesión HTTP (Fase 1)
- Cookie `sid` (`__Host-sid` en producción): `HttpOnly`, `SameSite=Lax`, `Secure` en producción, `Max-Age` 12 h. El valor es un secreto de 256 bits; en BD solo su SHA-256 (`auth.sessions`).
- Cada petición: cookie → `resolve_session` (identidad activa + negocio activo vigente) → `TenantContext` → `RbacService.loadAccess` (**sin caché**: los permisos se calculan en cada petición, así un cambio de negocio o de membresía no deja nada del anterior).
- **Anti-CSRF:** toda petición que modifica estado exige `X-Requested-With: checador` (además de `SameSite`). La API del dispositivo (`/api/kiosk/*`) usa `Authorization: Bearer` y no cookies.
- El panel (Next.js) es el único servicio expuesto: `/api/*` se reenvía a la API por red interna, de modo que la cookie es de primera parte.

### 2.7 Procesos en segundo plano (Fase 3+)
`core.list_active_organizations()` → cada negocio se procesa en **su propia transacción con su propio contexto**. Un error en uno no afecta a los demás; los suspendidos se omiten.

### 2.8 Tiempo real (Fase 4)
Canales por `organization_id:branch_id`; al abrir el stream se verifica el alcance del usuario.

### 2.9 Auditoría y operaciones de plataforma
`audit.audit_log` (por negocio, con sucursal cuando aplica, solo-agregar, escrita **en la misma transacción**, con redacción automática de PIN/hash/contraseña/token). `platform.platform_audit_log` para altas de negocio y restablecimientos. Operaciones de plataforma por **CLI** (`apps/api/src/cli/platform.ts`): crear negocio (zona horaria obligatoria; siembra roles `ADMIN`/`ENCARGADO` y primer administrador), suspender/reactivar, restablecer contraseña global.

## 3. Jerarquía de políticas (D-20)

`Plataforma → Negocio → Sucursal → Empleado`. `platform.policy_defaults` (completa) + `core.policy_overrides` (**solo overrides**). `resolvePolicy()` es una función pura; `PoliciesService.getEffective()` lee las capas bajo RLS y la calcula. Cada parámetro declara hasta qué nivel puede sobrescribirse (en código y con `CHECK` en PostgreSQL). Aplica a tolerancia, entrada anticipada, pausas, corte operativo y futuras políticas heredables. La zona horaria es atributo del negocio (obligatoria) y de la sucursal (opcional), no política.

## 4. Preparado para offline y para nómina (sin implementarlos)

- **Offline (D-12):** el modelo de `punch_events` ya incluye `client_event_id`, `device_id`, `occurred_at`, `received_at`, `source`, `time_source` y unicidad `(organization_id, device_id, client_event_id)` (`02-modelo-de-datos.md §8`). En el MVP la API exige conexión y el kiosco muestra "Sin conexión".
- **Nómina/periodos de pago:** nada en el modelo asume su ausencia; la comida no afecta horas y no existe entidad "periodo". Se agregarán como módulo con su propio esquema y `organization_id` + RLS (CI lo exige).

## 5. Estructura del repositorio

```
.
├─ apps/api/                         # NestJS + dominio
│  ├─ db/migrations/                 # SQL oficial (0001…0005)
│  ├─ src/
│  │  ├─ common/tenancy/             # TenantContext, TenantDb, PlatformDb, Gate
│  │  ├─ db/                         # pool, migrador, bootstrap de roles, esquema Drizzle
│  │  ├─ modules/{audit,auth,core,organizations,policies}
│  │  ├─ http/                       # controladores Nest (Fase 0: /health)
│  │  ├─ cli/                        # bootstrap, migrate, check-tenancy, platform
│  │  ├─ container.ts                # raíz de composición (sin PlatformDb)
│  │  └─ app.module.ts, main.ts
│  └─ test/                          # 14 archivos, PostgreSQL real
├─ apps/web/                         # panel Next.js (proxy /api, i18n, E2E Playwright)
├─ scripts/e2e.sh                    # E2E contra API + PostgreSQL reales
├─ docs/                             # reglas, modelo, arquitectura, operación
├─ docker-compose.yml                # producción (Coolify): db → init → api (+ perfil tools)
├─ docker-compose.dev.yml
└─ .github/workflows/ci.yml
```
`apps/web` (Next.js) contiene el panel (Fase 1). `packages/shared` (esquemas/tipos compartidos) se creará cuando haya código que compartir de verdad (p. ej. el kiosco). Los errores de dominio llevan **códigos estables** (`DomainError.code`), nunca textos: el cliente los traduce (RN-I18N-01).

## 6. Flujos clave

### 6.1 Checada en kiosco (Fases 1–3)
```mermaid
sequenceDiagram
  participant K as Kiosco
  participant API as API
  participant DB as PostgreSQL
  K->>API: identify {pin} + token de dispositivo
  API->>DB: resolve_kiosk_token → (organization, branch, device) [función-puerta]
  API->>DB: BEGIN; set org; ¿bloqueado por intentos?; empleado por HMAC(pepper, org‖pin); registra intento
  API-->>K: sesión corta + acciones permitidas
  K->>API: punch {type, client_event_id}
  API->>DB: BEGIN; set org; bloquear jornada; validar transición; insertar punch_event; recalcular; incidencias; auditoría; COMMIT
  API-->>K: confirmación (hora del servidor)
```
**Ya implementado (Fases 0–1):** alta de dispositivo desde el panel, token (negocio+sucursal+dispositivo) generar/revocar/regenerar, activar/desactivar, emparejamiento por código, `POST /api/kiosk/identify` con pausa progresiva por dispositivo (D-21) y registro de intentos. El token **nunca** puede cruzar a otro negocio; la sucursal sale del token.

### 6.2 Corrección (Fase 5)
Motivo obligatorio ⇒ validar misma organización (RLS), sucursal donde ocurrió la jornada dentro del alcance, **no es la propia jornada** ⇒ transacción: checadas nuevas + anulaciones + recálculo + incidencia + auditoría.

## 7. Seguridad

| Actor | Mecanismo |
|---|---|
| Admin / Encargado | Correo + contraseña global (argon2id), cookie de sesión `httpOnly`/`Secure`/`SameSite=Lax` ligada a un negocio; bloqueo tras 5 fallos |
| Kiosco | Token `kt_<prefijo>.<secreto>`; solo el SHA-256 del secreto en BD; comparación en tiempo constante; revocable; el negocio suspendido invalida sus tokens |
| Empleado en kiosco | PIN de 6 dígitos + token ⇒ sesión corta |
| Plataforma | CLI con `platform_ops`; credenciales fuera de la API |

- **PIN:** aleatorio criptográfico, sin triviales; valor indexable `HMAC-SHA256(PIN_PEPPER, organization_id + ":" + PIN)` (único por negocio, sin correlación entre negocios); se muestra una vez; el empleado no lo cambia; restablecer invalida el anterior; auditoría y logs sin el PIN; **pausa corta y progresiva por dispositivo (D-21)**: 10 s → … → tope 120 s, nunca bloqueos largos del kiosco compartido.
- **Secretos** solo como variables de entorno en Coolify. **HTTPS** por el proxy. **Hora:** servidor en UTC. Mensajes de error genéricos para PIN y credenciales.

## 8. Kiosco (UX, Fase 3)

PWA en pantalla completa; **logo y nombre del negocio** y de la sucursal, campo de código y teclado numérico grande; solo los botones permitidos; reloj del servidor; **"Sin conexión"** visible (MVP: contingencia = corrección manual con motivo); "lanzador del empleado" que podrá alojar mesas, adelantos, comunicados.

## 9. Despliegue en Coolify

`docker-compose.yml`: `db` (postgres:16) → `init` (bootstrap de roles + migraciones + `check:tenancy`, idempotente en cada despliegue) → `api` (solo `app_user`; healthcheck `/health`). Perfil `tools` con el CLI de plataforma. Variables en `.env.example`. **Respaldos fuera del servidor** con prueba de restauración (la base contiene a todos los negocios: cifrar y restringir acceso). Detalle y *runbook* en `04-operacion.md`.

Servicio `web` (Next.js standalone): único con dominio público; `API_INTERNAL_URL=http://api:3000`. La API usa `COOKIE_SECURE=true` (por eso el panel debe servirse por HTTPS).

**Criterios OBLIGATORIOS antes de considerar el sistema desplegable** (pendientes):
1. En un entorno con Docker: construir ambos `Dockerfile`, `docker compose up` sobre base limpia, migraciones, pruebas completas, API y panel arriba.
2. ✅ Una ejecución **real** de GitHub Actions en verde sobre PostgreSQL real (run #5, commit `cc1d7cb`).

> Estado honesto: los `Dockerfile`/`docker-compose.yml` no se han podido ejecutar (el entorno de desarrollo no tiene Docker). Sí se verificó el flujo equivalente con los artefactos compilados contra PostgreSQL real: bootstrap → migrate → `check:tenancy` → alta de Fatboy → API → panel (incluido el servidor *standalone* de Next) → E2E con Playwright. GitHub Actions: ✅ en verde desde el run #5.

## 10. Plan por fases

| Fase | Entrega | Estado |
|---|---|---|
| **0 · Fundaciones + multi-tenant** | PostgreSQL + migraciones, `organizations`, `branches`, identidades globales, membresías, roles y alcance por sucursal, empleados, kioscos, contexto seguro de negocio, RLS, roles sin bypass, auditoría, políticas con herencia, pruebas de aislamiento A↔B, verificación de catálogo en CI, CLI, Docker/CI | ✅ **Hecha** |
| **1 · Identidad, sesión y administración base** | D-21; login/logout, sesión por cookie con rotación, selector y cambio de negocio, invitaciones de un solo uso, RBAC HTTP por sucursal, CRUD de sucursales/empleados/kioscos/políticas (override vs efectiva), auditoría; panel web funcional; E2E | ✅ **Hecha** (pendiente: criterios de despliegue §9) |
| 2 · Horarios | Plantillas, programación semanal, turnos nocturnos | Pendiente |
| 3 · Motor de asistencia | Kiosco, máquina de estados, pausas, cálculo, incidencias, corte operativo, jobs por negocio | Pendiente |
| 4 · Tablero en vivo | SSE por negocio/sucursal | Pendiente |
| 5 · Correcciones | Flujo + visor de auditoría | Pendiente |
| 6 · Reportes | Consultas + Excel + accesos rápidos de periodo | Pendiente |
| 7 · Autoservicio del empleado | Horarios/asistencias/incidencias en kiosco | Pendiente |
| Después | Recuperación por correo, modo offline, PDF, QR/cámara, nómina, UI de plataforma, planes/facturación | — |

## 11. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Fuga entre negocios | RLS forzado + FKs compuestas + rol sin `BYPASSRLS` + contexto obligatorio que falla cerrado + CI (catálogo y pruebas A↔B por tabla) |
| Consulta que olvide el contexto | Sin contexto la BD devuelve 0 filas; el pool crudo está vedado por prueba de arquitectura |
| Funciones-puerta (únicas sin contexto) | Mínimas, `SECURITY DEFINER` con `search_path` fijo, dueño sin login, pruebas específicas |
| Pérdida del `PIN_PEPPER` | Respaldarlo en un gestor de secretos; si se pierde, regenerar PIN de todos |
| Respaldo único con todos los negocios | Cifrado, acceso restringido, restauración probada |
| Caída de internet en una sucursal | MVP: "Sin conexión" + corrección manual; modelo listo para offline; UPS |
| Compañeros que se prestan el PIN | Mejora futura: foto/QR/biometría |
| Reglas ambiguas | Reglas v1.0 congeladas + decisiones registradas |

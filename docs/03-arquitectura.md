# 03 · Arquitectura

> **Versión 1.4 — CONGELADA.** Estado: **Fases 0, 1, 2, 3 y 4 implementadas y probadas** (ver §10). CI de GitHub Actions en verde. La validación con Docker/Coolify la realiza el dueño en su servidor (§9).

## 1. Resumen

**Monolito modular multi-tenant** en TypeScript, en un monorepo (pnpm), desplegado con Docker Compose en Coolify. **Una sola base PostgreSQL y un solo esquema compartidos por todos los negocios**, aislados con `organization_id` + **Row-Level Security** y roles de BD sin `BYPASSRLS`. Fatboy es el primer negocio (tenant).

| Capa | Tecnología | Estado |
|---|---|---|
| Backend | **NestJS 11** (API REST + SSE) sobre servicios de dominio sin decoradores (testeables con PostgreSQL real) | Fase 1: autenticación, sesiones, negocio activo, RBAC y administración base |
| Base de datos | **PostgreSQL 16** — RLS, constraints, índices parciales, exclusiones (`btree_gist`), triggers | Fase 0 completa |
| Acceso a datos | **Drizzle ORM** para consultas tipadas; **migraciones SQL propias** como fuente de verdad | Fase 0 |
| Validación | **Zod** | Fase 0 |
| Frontend | **Next.js 16 + React 19**, CSS propio (sin framework visual todavía); panel funcional responsive; textos por **sistema de traducciones** (es-MX). El panel reenvía `/api/*` a la API (proxy del mismo origen) | Fase 1: panel. Fase 3: kiosco táctil (`/kiosco`) y asistencia |
| Tiempo real | **SSE** (`LISTEN/NOTIFY` de PostgreSQL → `EventSource`), polling de respaldo | Fase 4 |
| Excel / CSV | `exceljs` 4.4.0 (fijada) · CSV propio (RFC 4180, BOM, fórmulas neutralizadas) | Fase 4 |
| Pruebas | Vitest + PostgreSQL real (sin mocks de BD) + Playwright (E2E del panel y del kiosco) | 373 pruebas + 12 E2E |
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

### 2.6.2 Planificación (Fase 2)
- `SchedulingService` recibe el `AccessProfile` de la petición y aplica: alcance por sucursal (D-30), protección de turnos históricos (D-32), validación de asignación/empleado/sucursal, política de duración, DST (`common/zoned-time.ts`, basado en la base de zonas IANA de `Intl`, sin offsets fijos) y concurrencia optimista (`version`).
- PostgreSQL impone: exclusión de traslapes, `ends_at > starts_at`, FKs compuestas turno↔horario↔sucursal↔empleado, horario publicado irreversible, cancelado congelado y prohibición de borrar turnos publicados.
- Copiar semana / aplicar plantilla comparten un generador con *savepoint* por turno, `dryRun` y resultado detallado.

### 2.6.3 Asistencia (Fase 3)
- **Módulo `modules/attendance`** separado de la planificación: `KioskAttendanceService` (identificar PIN, acciones, checadas), `ReconcilerService`, `CorrectionsService`, `AttendanceQueryService` (tablero, jornadas, detalle, historial, incidencias) y `attendance-time.ts` (reglas puras: minutos con segundos truncados, día operativo, corte, estados de llegada, métricas).
- **Matching turno ↔ jornada** (D-35): `shiftsInWindow` busca turnos OFICIALES del empleado en la sucursal del kiosco con `starts_at − early_entry_window_min ≤ ahora < ends_at` y sin jornada; gana el inicio más cercano. Sin coincidencia ⇒ jornada sin turno + marcas (D-6, D-36).
- **Concurrencia** (D-55): cada checada bloquea la fila del empleado (`SELECT … FOR UPDATE`), así se serializan doble toque, dos kioscos y reintentos; PostgreSQL además impone una jornada `OPEN` por empleado, una pausa abierta por jornada, idempotencia `(device_id, client_event_id)` y la exclusión de jornadas cerradas que se cruzan.
- **Invariantes en la BD**: solo turnos oficiales se ligan; no se cierra con pausa abierta; una cerrada no se reabre; eventos y correcciones solo-agregar; nadie corrige su propia jornada; un turno con jornada no se cancela; un turno publicado no se mueve a un horario no publicado (D-33).
- **Kiosco** (D-56): `POST /api/kiosk/activate` valida el token (o el código de emparejamiento), **rota** la credencial y la entrega en la cookie `HttpOnly` `kiosk`/`__Host-kiosk` (`SameSite=Strict`). `identify` aplica D-21 y devuelve un **pase firmado** de 120 s (HMAC con clave derivada del secreto del servidor) con el que `punch` registra la acción sin reenviar el PIN.

### 2.7 Procesos en segundo plano (Fase 3)
`core.list_active_organizations()` → cada negocio se procesa en **su propia transacción con su propio contexto** (rol `app_user`, sin `BYPASSRLS`) y con un candado consultivo. Un error en uno no afecta a los demás; los suspendidos se omiten. Hoy: la reconciliación de asistencia (`node dist/src/cli/reconcile.js`, idempotente), programable en Coolify o dentro de la API con `RECONCILE_INTERVAL_SEC`.

### 2.8 Tiempo real (Fase 4)
- **Origen:** triggers `AFTER INSERT OR UPDATE` en jornadas, pausas, incidencias y solicitudes emiten `pg_notify('att_<negocio>', {k, id, b, op})` (transaccional: solo si se confirma). Sin nombres ni datos personales: es una **invalidación**.
- **API:** `NotificationHub` mantiene UNA conexión dedicada por proceso y hace `LISTEN` por negocio solo mientras hay suscriptores; si la conexión se cae, reconecta y manda `resync`. `GET /api/attendance/stream?branchId=` exige `attendance.view` y la sucursal en el alcance (otra sucursal u otro negocio ⇒ 404); reenvía solo avisos de su negocio y de las sucursales de su alcance; `ping` cada 25 s; revalida sesión/negocio/permisos cada 60 s y cierra si cambian; vida máxima 30 min; 5 conexiones por usuario (429).
- **Panel:** `useLive` (`EventSource` con la cookie de sesión) agrupa los avisos y vuelve a consultar los endpoints normales (RBAC + RLS). Sin canal (error, 60 s sin `ping`) ⇒ polling cada 30 s e indicador; reintento con espera creciente. El proxy `/api/*` de Next transmite `text/event-stream` sin búfer (`x-accel-buffering: no`).
- **Consistencia:** perder un aviso solo retrasa la pantalla (recarga de respaldo cada 2 min aun con canal activo); nunca es fuente de verdad.

### 2.8.1 Solicitudes, reportes y kioscos (Fase 4)
- **Solicitudes** (`CorrectionRequestsService`): crear (kiosco por pase, panel por membresía con ficha; idempotente), cancelar, aprobar y rechazar. Aprobar ejecuta `CorrectionsService.applyTx/createSessionTx` en la MISMA transacción, con el instante absoluto guardado y `request_id`; si falla, nada cambia. Unicidad, transiciones y "nadie decide la suya" también en PostgreSQL.
- **Reportes** (`ReportsService`): una lectura `REPEATABLE READ` de solo lectura con alcance por sucursal (`reports.view`, y `reports.export` para exportar); periodos rápidos calculados en el servidor con el día operativo; exportación XLSX/CSV generada al momento, auditada y limitada (366 días, 100 000 filas, 10/min por usuario).
- **Kioscos:** estado derivado, `activated_at`, último uso e IP (a lo más una escritura por minuto); "Revocar ahora" invalida la credencial y la siguiente petición del navegador falla.

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
│  ├─ db/migrations/                 # SQL oficial (0001…0008)
│  ├─ src/
│  │  ├─ common/tenancy/             # TenantContext, TenantDb, PlatformDb, Gate
│  │  ├─ db/                         # pool, migrador, bootstrap de roles, esquema Drizzle
│  │  ├─ modules/{audit,auth,core,organizations,policies,scheduling,attendance}
│  │  ├─ http/                       # controladores Nest (panel, kiosco, asistencia)
│  │  ├─ cli/                        # bootstrap, migrate, check-tenancy, platform, reconcile
│  │  ├─ container.ts                # raíz de composición (sin PlatformDb)
│  │  └─ app.module.ts, main.ts
│  └─ test/                          # 24 archivos, PostgreSQL real
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
  K->>API: identify {pin} + cookie del dispositivo
  API->>DB: resolve_kiosk_token → (organization, branch, device) [función-puerta]
  API->>DB: BEGIN; set org; ¿pausa D-21?; empleado por HMAC(pepper, org‖pin); registra intento; COMMIT
  API->>DB: BEGIN; set org; ¿jornada vencida? ⇒ REVIEW; acciones posibles; turno oficial; COMMIT
  API-->>K: pase firmado (120 s) + nombre + turno + acciones
  K->>API: punch {ticket, action, client_event_id}
  API->>DB: BEGIN; set org; bloquear empleado; ¿mismo client_event_id? ⇒ misma respuesta; antirrebote; validar transición; matching turno; insertar jornada/pausa + evento; incidencias; auditoría; COMMIT
  API-->>K: confirmación (hora del servidor)
```
**Implementado (Fases 0–3):** activación del navegador con rotación de la credencial (cookie `HttpOnly`), pase corto tras el PIN, las cuatro acciones con idempotencia y concurrencia segura. Antes (Fases 0–1): alta de dispositivo desde el panel, token (negocio+sucursal+dispositivo) generar/revocar/regenerar, activar/desactivar, emparejamiento por código, `POST /api/kiosk/identify` con pausa progresiva por dispositivo (D-21) y registro de intentos. El token **nunca** puede cruzar a otro negocio; la sucursal sale del token.

### 6.2 Corrección (Fase 3) y solicitud (Fase 4)
**Solicitud (Fase 4):** empleado (kiosco: PIN → "Mis registros"; panel: "Mis jornadas") ⇒ ventana por día operativo, límite de pendientes, una pendiente igual por objetivo ⇒ `PENDING` (la jornada no cambia) ⇒ aviso SSE a la bandeja ⇒ el decisor (otra persona, con `attendance.correction.apply` donde ocurrió) **aprueba exactamente lo solicitado** (corrección + `request_id` + auditoría, en una transacción) o **rechaza con motivo** ⇒ el empleado ve el resultado.

**Corrección directa:**
Motivo obligatorio ⇒ misma organización (RLS), sucursal donde ocurrió la jornada dentro del alcance, **no es la propia jornada** (servicio + trigger), versión vista ⇒ transacción: valor efectivo nuevo + fila en `corrections` (original, corregido, antes/después) + recálculo de retardo/comida + incidencias resueltas como `CORRECTED` + auditoría. El evento físico nunca se toca.

## 7. Seguridad

| Actor | Mecanismo |
|---|---|
| Admin / Encargado | Correo + contraseña global (argon2id), cookie de sesión `httpOnly`/`Secure`/`SameSite=Lax` ligada a un negocio; bloqueo tras 5 fallos |
| Kiosco | Token `kt_<prefijo>.<secreto>`; solo el SHA-256 del secreto en BD; comparación en tiempo constante; revocable; el negocio suspendido invalida sus tokens |
| Empleado en kiosco | PIN de 6 dígitos + token ⇒ sesión corta |
| Plataforma | CLI con `platform_ops`; credenciales fuera de la API |

- **PIN:** aleatorio criptográfico, sin triviales; valor indexable `HMAC-SHA256(PIN_PEPPER, organization_id + ":" + PIN)` (único por negocio, sin correlación entre negocios); se muestra una vez; el empleado no lo cambia; restablecer invalida el anterior; auditoría y logs sin el PIN; **pausa corta y progresiva por dispositivo (D-21)**: 10 s → … → tope 120 s, nunca bloqueos largos del kiosco compartido.
- **Secretos** solo como variables de entorno en Coolify. **HTTPS** por el proxy. **Hora:** servidor en UTC. Mensajes de error genéricos para PIN y credenciales.

## 8. Kiosco (UX, Fases 3–4)

`/kiosco` en pantalla completa (Fase 3): **logo y nombre del negocio** y de la sucursal, reloj del servidor, PIN enmascarado con teclado numérico grande, borrar y confirmar; después nombre, turno oficial y **solo los botones posibles**; confirmación grande y regreso automático (20 s de inactividad, 4 s tras checar); **"Sin conexión"** visible (MVP: contingencia = corrección con motivo, que puede crear la jornada). Fase 4: botón **"Mis registros"** tras el PIN (jornadas, pausas y faltas de la ventana, y sus solicitudes) con "Solicitar corrección"; pase renovado en cada acción, 20 s de inactividad, "Terminar", y limpieza total del estado al salir, al vencer el pase o al ocultarse la pestaña (sin navegación para volver). Futuro: "lanzador del empleado" (mesas, adelantos, comunicados).

## 9. Despliegue en Coolify

`docker-compose.yml`: `db` (postgres:16) → `init` (bootstrap de roles + migraciones + `check:tenancy`, idempotente en cada despliegue) → `api` (solo `app_user`; healthcheck `/health`). Perfil `tools` con el CLI de plataforma. Variables en `.env.example`. **Respaldos fuera del servidor** con prueba de restauración (la base contiene a todos los negocios: cifrar y restringir acceso). Detalle y *runbook* en `04-operacion.md`.

Servicio `web` (Next.js standalone): único con dominio público; `API_INTERNAL_URL=http://api:3000`. La API usa `COOKIE_SECURE=true` (por eso el panel debe servirse por HTTPS).

**Validación de despliegue:** GitHub Actions en verde sobre PostgreSQL real (desde el run #5). Docker/Coolify (imágenes, red interna, HTTPS, cookies `Secure`, persistencia, reinicios) lo valida el dueño en su servidor; el repositorio mantiene listos los `Dockerfile`, `docker-compose.yml`, variables y documentación.

> Estado honesto: los `Dockerfile`/`docker-compose.yml` no se han podido ejecutar (el entorno de desarrollo no tiene Docker). Sí se verificó el flujo equivalente con los artefactos compilados contra PostgreSQL real: bootstrap → migrate → `check:tenancy` → alta de Fatboy → API → panel (incluido el servidor *standalone* de Next) → E2E con Playwright. GitHub Actions: ✅ en verde desde el run #5.

## 10. Plan por fases

| Fase | Entrega | Estado |
|---|---|---|
| **0 · Fundaciones + multi-tenant** | PostgreSQL + migraciones, `organizations`, `branches`, identidades globales, membresías, roles y alcance por sucursal, empleados, kioscos, contexto seguro de negocio, RLS, roles sin bypass, auditoría, políticas con herencia, pruebas de aislamiento A↔B, verificación de catálogo en CI, CLI, Docker/CI | ✅ **Hecha** |
| **1 · Identidad, sesión y administración base** | D-21; login/logout, sesión por cookie con rotación, selector y cambio de negocio, invitaciones de un solo uso, RBAC HTTP por sucursal, CRUD de sucursales/empleados/kioscos/políticas (override vs efectiva), auditoría; panel web funcional; E2E | ✅ **Hecha** (pendiente: criterios de despliegue §9) |
| **2 · Horarios y turnos** | Horario semanal DRAFT/PUBLISHED, turno concreto con zona y DST, traslapes en PostgreSQL, alcance del encargado, histórico protegido, concurrencia optimista, copiar semana, plantillas; pantalla "Horario semanal", plantillas y próximos turnos del empleado | ✅ **Hecha** |
| **3 · Asistencia** | D-33; kiosco táctil con activación segura; jornadas, eventos inmutables, pausas, matching con turnos oficiales, día operativo, incidencias, reconciliación, correcciones auditadas, tablero (consulta cada 30 s), jornadas, incidencias, historial | ✅ **Hecha** |
| **4 · Cierre del ciclo** | D-66…D-77: FALTA anulada por el plan, salida anticipada, sin comida, pausa omitida; solicitudes de corrección (kiosco y panel) con aprobación exacta o rechazo; reportes con periodos rápidos y exportación XLSX/CSV; tablero y bandeja en tiempo real (SSE + polling); estado, último uso y revocación inmediata de kioscos | ✅ **Hecha** (contrato `05-fase-4-contrato.md`) |
| Siguiente | Reprocesos por cambio de política, autoservicio ampliado (horarios en kiosco), PDF, notificaciones | Pendiente |
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

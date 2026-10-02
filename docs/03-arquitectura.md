# 03 · Arquitectura

## 1. Resumen de la propuesta

**Monolito modular multi-tenant** en TypeScript, en un monorepo, desplegado con Docker Compose en Coolify. **Una sola base de datos y un solo esquema compartidos por todos los negocios**, aislados con `organization_id` + **Row-Level Security** de PostgreSQL. Fatboy es el primer negocio (tenant).

| Capa | Tecnología | Motivo |
|---|---|---|
| Frontend | **Next.js (App Router) + React + Tailwind** | Un app con dos zonas: `/kiosk` (táctil) y `/admin` (panel). Marca (nombre/logo/colores) cargada **por negocio**. |
| Backend | **NestJS** (API REST + SSE) | Módulos, guards de permisos, contexto de negocio por petición, tareas programadas. |
| Base de datos | **PostgreSQL 16+** | RLS, restricciones de exclusión, índices parciales, triggers, `timestamptz`. |
| ORM | **Drizzle** (recomendado) — alternativa Prisma | Ver §3. |
| Validación compartida | **Zod** en `packages/shared` | Mismos esquemas/tipos en API y web. |
| Tiempo real | **SSE** | Más simple que WebSockets para empujar actualizaciones. |
| Excel | `exceljs` | PDF después. |
| i18n | Textos en archivos de traducción desde el inicio | UI en español hoy; otro idioma mañana sin rehacer. |
| Pruebas | Vitest/Jest + Testcontainers (Postgres real) | Reglas de asistencia **y aislamiento entre negocios**. |

### ¿Por qué NestJS y no solo rutas API de Next.js?
1. **Crecimiento:** mesas, adelantos, nómina, comunicados serán módulos con reglas, jobs y permisos propios.
2. **Procesos en segundo plano** (faltas, jornadas vencidas) necesitan un proceso de larga vida.
3. **Tiempo real** con suscriptores en memoria por negocio/sucursal.
4. **Múltiples clientes** (kiosco, panel, quizá móvil/QR) sobre la misma API.
5. **Contexto de negocio** (tenant) como pieza transversal y obligatoria: es más natural y auditable en un backend dedicado.

## 2. Estrategia multi-tenant

### 2.1 Modelo elegido: base compartida + esquema compartido + RLS
| Opción | Aislamiento | Costo operativo | Veredicto |
|---|---|---|---|
| **Compartida + `organization_id` + RLS** | Alto (impuesto por la BD) | Bajo: una migración, un respaldo | ✅ **Elegida** |
| Esquema por negocio | Alto | Migraciones ×N, difícil crecer | ❌ |
| Base de datos por negocio | Máximo | Muy alto | ❌ ahora; **posible después** para un cliente grande, sin cambiar el modelo |

### 2.2 Cómo viaja el negocio en cada petición
```mermaid
sequenceDiagram
  participant C as Cliente (panel / kiosco)
  participant G as Guard de autenticación
  participant T as TenantContext (AsyncLocalStorage)
  participant DB as PostgreSQL (RLS)
  C->>G: cookie de sesión  |  token de kiosco
  G->>G: resuelve organization_id (+ branch_id / alcance) DESDE LA SESIÓN o el TOKEN
  G->>T: fija {organizationId, userId|deviceId, scope}
  T->>DB: BEGIN; set_config('app.organization_id', id, true); ... consultas ...; COMMIT
  DB-->>T: solo filas del negocio (RLS)
```
- **El `organization_id` nunca se acepta del body, query ni cabeceras del cliente.**
- Todo acceso a datos pasa por **un único componente** (`TenantDb.run(fn)`) que abre la transacción y fija el contexto. El pool "crudo" no se exporta; una regla de lint prohíbe importarlo. Sin contexto ⇒ la BD devuelve 0 filas (falla cerrado).
- El valor se fija con alcance de transacción (`set_config(..., true)`), de modo que **no se filtra entre peticiones** del pool de conexiones.

### 2.3 Las tres capas de defensa
1. **Backend:** guards de autenticación/permiso y filtro por **alcance de sucursal** en cada consulta.
2. **Acceso a datos:** el contexto de negocio es obligatorio; los repositorios incluyen `organization_id` explícitamente en inserciones.
3. **PostgreSQL:** FKs compuestas `(organization_id, id)` + RLS `FORCE` con política `organization_id = current_org()`, rol de aplicación `NOBYPASSRLS` (ver `02-modelo-de-datos.md` §3).

### 2.4 Identidad, sesión y negocio activo
- `auth.users` es **global** (un correo = una identidad). Una persona con acceso a dos negocios no duplica cuenta **[D-19]**.
- Login: correo + contraseña ⇒ se listan sus membresías ⇒ si hay una, entra directo; si hay varias, **elige el negocio**. La sesión queda **ligada a un solo negocio** (cookie `httpOnly`). Cambiar de negocio = nueva elección explícita.
- Autorización = permisos del rol + **alcance** (todas las sucursales o lista) calculados desde `role_assignments`. Se cachean por sesión con invalidación al cambiar roles.
- El kiosco **no** usa cookies de usuario: usa token de dispositivo (§6).

### 2.5 Procesos en segundo plano
El scheduler obtiene negocios activos con `core.list_active_organizations()` y procesa **cada negocio en su propia transacción con su propio contexto** (RLS activo). Un error en un negocio no afecta a los demás. Los negocios `SUSPENDED` se omiten.

### 2.6 Tiempo real
Canales por `organization_id:branch_id`. Al abrir el stream SSE se verifica que la sucursal esté dentro del alcance del usuario; el bus de eventos incluye siempre el negocio.

### 2.7 Auditoría
Toda entrada de `audit_log` lleva `organization_id` y, cuando aplica, `branch_id`. Las operaciones de plataforma (alta de negocio, soporte) van a `platform.platform_audit_log`.

### 2.8 Operaciones de plataforma (sin UI por ahora)
Un **CLI interno** (`apps/platform-cli`) conectado con el rol `platform_ops` permite: crear negocio (siembra política inicial, roles `ADMIN`/`ENCARGADO` y primer administrador), suspender/reactivar, listar. No hay facturación, planes ni onboarding: solo el mínimo para operar Fatboy y poder agregar otro negocio sin tocar la base manualmente.

### 2.9 Qué se deja preparado (sin construirlo)
Tabla/esquema `platform` listo para planes y suscripciones; campo `status` del negocio; subdominio por negocio (`slug`); límites de uso por negocio; administración de plataforma con UI. Nada de esto requerirá rediseñar datos ni autenticación.

## 3. Decisión de ORM: Drizzle vs Prisma

| | Drizzle (recomendado) | Prisma |
|---|---|---|
| Índices parciales, `EXCLUDE`, triggers, vistas, **políticas RLS** | SQL en las migraciones; el esquema TS convive bien | SQL manual fuera de su esquema declarativo; más fricción |
| **Contexto de negocio por transacción** (`set_config`) | Directo: una transacción donde se fija el contexto y se ejecutan las consultas | Requiere extensión de cliente y `$transaction` en cada operación; más fácil que se escape una consulta sin contexto |
| Esquemas Postgres múltiples | Soportado | Soportado con más ceremonia |
| `SELECT … FOR UPDATE` | Directo | `$queryRaw` |
| Ecosistema | Menor | Mayor |

Por el peso de **RLS + restricciones de Postgres**, prefiero Drizzle **[D-13]**.

## 4. Estructura del repositorio

```
claude-app-checador/
├─ apps/
│  ├─ api/                    # NestJS
│  │  └─ src/
│  │     ├─ common/tenancy/   # TenantContext, TenantDb, guards, decoradores
│  │     ├─ modules/
│  │     │  ├─ organizations/ # negocio, marca, configuración base
│  │     │  ├─ core/          # sucursales, empleados, asignaciones, kioscos
│  │     │  ├─ auth/          # login panel, membresías, sesión de kiosco, RBAC
│  │     │  ├─ scheduling/    # plantillas, semanas, turnos
│  │     │  ├─ attendance/    # checadas, jornadas, incidencias, correcciones, motor de cálculo
│  │     │  ├─ reports/       # consultas + Excel
│  │     │  ├─ realtime/      # SSE por negocio/sucursal
│  │     │  ├─ settings/      # políticas en cascada
│  │     │  └─ audit/         # bitácora
│  │     └─ db/               # esquema Drizzle + migraciones SQL (incluye RLS)
│  ├─ platform-cli/           # operaciones de plataforma (alta de negocio, etc.)
│  └─ web/                    # Next.js
│     └─ src/app/
│        ├─ kiosk/            # emparejar, identificar, acciones, mis horarios/asistencias
│        └─ admin/            # panel
├─ packages/
│  └─ shared/                 # zod schemas, enums, tipos, fechas
├─ docs/
├─ docker-compose.yml         # producción (Coolify)
├─ docker-compose.dev.yml
└─ README.md
```
Gestor: **pnpm workspaces** (+ Turborepo opcional).

### Reglas de modularidad
- Cada módulo expone una **interfaz pública** (servicios/eventos); no se leen tablas de otro módulo directamente.
- Los módulos futuros (`tables`, `advances`, `payroll`, `announcements`) se agregan con su propio esquema Postgres **y heredan automáticamente el aislamiento** (`organization_id` + RLS; el CI lo exige).
- **Motor de cálculo = función pura** `evaluateAttendance(events, shift, policy, branchCalendar)`; sin BD ni `Date.now()`.

## 5. Flujos clave

### 5.1 Checada en kiosco
```mermaid
sequenceDiagram
  participant K as Kiosco
  participant API as API
  participant DB as PostgreSQL
  K->>API: POST /kiosk/identify {pin}  + token de dispositivo
  API->>DB: resolve_kiosk_token → (organization_id, branch_id)
  API->>DB: BEGIN; set org; busca empleado por HMAC(pepper, org‖pin)
  API->>DB: evalúa jornada abierta vencida (RN-OPE-05)
  API-->>K: sesión corta + nombre + acciones permitidas
  K->>API: POST /kiosk/punch {type, client_event_id}
  API->>DB: BEGIN; set org; bloquear jornada; validar transición; insertar punch_event;<br/>recalcular; incidencias; auditoría; COMMIT
  API-->>K: confirmación (hora del servidor)
  API-->>Panel: SSE "attendance.updated" (negocio:sucursal)
```
- Negocio y sucursal **salen del token del dispositivo**, nunca del cliente.
- La sesión del empleado dura segundos y solo sirve para ese empleado, kiosco y negocio.

### 5.2 Tablero en tiempo real
Snapshot por `GET /branches/:id/live` (validado contra el alcance) + stream SSE; refresco cada ~30 s para estados que dependen del tiempo; "hoy" = día operativo de la sucursal.

### 5.3 Corrección
Encargado/admin crea la corrección con **motivo obligatorio** ⇒ el backend valida: misma organización (RLS), sucursal dentro del alcance, no es su propia jornada ⇒ transacción: checadas nuevas + anulaciones + recálculo + incidencia + auditoría ⇒ SSE.

### 5.4 Reportes
Consultas sobre `attendance_records` (+ turnos) por fecha laboral/sucursal/empleado, siempre dentro del negocio (RLS) y del alcance (filtro). Excel generado en servidor y servido por respuesta directa (no se guarda en disco compartido); exportación auditada.

## 6. Autenticación y seguridad

| Actor | Mecanismo |
|---|---|
| Administrador / Encargado | Correo + contraseña (argon2id), sesión `httpOnly` + `Secure` + `SameSite=Lax`, ligada a **un negocio**. Rate limit y bloqueo temporal. 2FA futuro. |
| Kiosco | Emparejamiento: el admin genera un **código de un solo uso** (vence en minutos) en el panel ⇒ la tablet lo canjea ⇒ recibe un **token** `prefijo.secreto` ligado a `(organización, sucursal)`. Se guarda hasheado; revocable. |
| Empleado en kiosco | PIN + token de dispositivo ⇒ sesión corta (~20 s). |
| Operaciones de plataforma | CLI con rol `platform_ops`; credenciales fuera de la API; todo en `platform_audit_log`. |

- **Autorización:** permiso + alcance de sucursal en cada endpoint. Las consultas **siempre** filtran por alcance (no se confía en IDs del cliente).
- **PIN:** `HMAC-SHA256(PEPPER, organization_id ‖ pin)`. `PIN_PEPPER` solo en variable de entorno. Límite de intentos por kiosco.
- **Hora:** solo del servidor (UTC, NTP del host).
- **Secretos** (`PIN_PEPPER`, `SESSION_SECRET`, `DATABASE_URL`…) solo como variables en Coolify.
- **HTTPS** por el proxy de Coolify.
- **Roles de BD separados:** `migrator`, `app_user` (`NOBYPASSRLS`, sin `DELETE`/sin `UPDATE` en tablas solo-agregar), `platform_ops`.
- **CORS** cerrado, `helmet`, validación Zod en cada endpoint, IDs opacos (uuid).
- **Pruebas de aislamiento obligatorias en CI** (RN-ORG-11): catálogo (toda tabla con RLS forzado) + intentos cruzados de lectura/escritura entre negocios para todas las tablas.

## 7. Kiosco (UX)

- Ruta `/kiosk`, instalable como **PWA** en pantalla completa (o Fully Kiosk Browser).
- Pantalla 1: **logo y nombre del negocio**, nombre de la sucursal, campo de código y teclado numérico grande. (Fatboy es solo el contenido de la marca del primer negocio.)
- Pantalla 2: saludo + **solo** los botones permitidos + "Mis horarios / Mi asistencia / Mis incidencias".
- Confirmación breve y regreso automático a la pantalla 1.
- Reloj visible (hora del servidor) y aviso claro si no hay conexión.
- **Sin conexión (MVP):** no se puede checar; contingencia: corrección manual con motivo **[D-12]**.
- "Lanzador del empleado": el menú podrá crecer con módulos (mesas, adelantos, comunicados) sin rehacer el login.

## 8. Despliegue en Coolify

| Servicio | Imagen | Notas |
|---|---|---|
| `db` | `postgres:16` | Volumen persistente; alternativa: recurso PostgreSQL de Coolify (respaldos programados). |
| `api` | Dockerfile multi-stage (Node LTS slim) | Healthcheck `/health`. Al arrancar **migra** (con `migrator`) y luego inicia (con `app_user`). 1 réplica. |
| `web` | Dockerfile multi-stage (Next.js standalone) | Healthcheck. |

- **Variables:** `DATABASE_URL` (app_user), `MIGRATOR_DATABASE_URL`, `PIN_PEPPER`, `SESSION_SECRET`, `TZ=UTC`, `APP_URL`, `API_URL`. `PLATFORM_DATABASE_URL` **solo** donde se ejecute el CLI.
- **Roles de BD:** los crea un script de inicialización/migración inicial.
- **Dominios:** un dominio para web y otro (o ruta `/api`) para la API. Un solo dominio para todos los negocios; el negocio se determina por **sesión/token**, no por el host (subdominios por negocio quedan como mejora futura).
- **Migraciones:** versionadas, idempotentes. Nunca cambios manuales a la BD.
- **Respaldos:** críticos (auditoría). Diarios, a destino **fuera del servidor**, con prueba de restauración. Al ser multi-tenant, un respaldo contiene a todos los negocios: cifrar y restringir acceso.
- **Logs:** JSON con `request_id` y `organization_id` (nunca PIN ni contraseñas).
- **Monitoreo:** healthchecks + alerta si un kiosco deja de reportar (`last_seen_at`).
- **Alta inicial:** `platform-cli create-organization --name Fatboy ...` crea el primer negocio, sus 3 sucursales, política base y el primer administrador.

## 9. Plan de implementación por fases

| Fase | Entrega | Qué valida |
|---|---|---|
| **0 · Fundaciones + multi-tenant** | Monorepo, Docker/Compose, CI, migraciones; **roles de BD, `organizations`, RLS, FKs compuestas, `TenantDb`/contexto, pruebas de aislamiento y verificación de catálogo en CI**, auth (usuarios, membresías, RBAC con alcance), auditoría base, CLI de alta de negocio | Despliegue en Coolify desde el día 1 y aislamiento probado antes de tener datos reales |
| **1 · Núcleo** | Sucursales, empleados, PIN, asignaciones, kioscos (emparejamiento) | Altas/bajas con auditoría |
| **2 · Horarios** | Plantillas, programación semanal, turnos nocturnos | RN-HOR |
| **3 · Motor de asistencia** | Kiosco, máquina de estados, cálculo, incidencias, corte operativo, jobs por negocio | RN-EVT, RN-CAL, RN-OPE, RN-INC |
| **4 · Tablero en vivo** | SSE por negocio/sucursal | RN-RT |
| **5 · Correcciones + auditoría** | Flujo de correcciones, visor de auditoría | RN-COR, RN-AUD |
| **6 · Reportes** | Consultas + Excel | RN-REP |
| **7 · Autoservicio del empleado** | Mis horarios/asistencias/incidencias en kiosco | RN-ROL |
| **Después** | PDF, QR/cámara, offline, RH, festivos, módulos nuevos, UI de plataforma, planes/facturación | — |

## 10. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| **Fuga de datos entre negocios** | RLS forzado + FKs compuestas + rol sin `BYPASSRLS` + contexto obligatorio que falla cerrado + pruebas de aislamiento y chequeo de catálogo en CI |
| Consulta que olvide el contexto | Sin contexto la BD devuelve 0 filas; el pool crudo no es accesible; lint |
| Sobrecarga de un negocio grande ("vecino ruidoso") | Índices por `organization_id`; límites futuros; posibilidad de mover un negocio a su propia BD |
| Respaldo único con todos los negocios | Cifrado, acceso restringido, pruebas de restauración |
| Caída de internet/servidor en una sucursal | Modo offline futuro; mientras, contingencia manual; UPS |
| Compañeros que se prestan el PIN | Mejora futura: foto/QR/biometría; `punch_events` admite adjuntar evidencia |
| Pérdida de datos | Respaldos fuera del servidor + restauración probada |
| Reglas ambiguas | Documento de decisiones + pruebas con casos concretos |
| Desfase de hora | UTC desde el servidor + NTP; zona y corte por sucursal |

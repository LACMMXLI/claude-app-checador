# 03 · Arquitectura

## 1. Resumen de la propuesta

**Monolito modular** en TypeScript, en un monorepo, desplegado con Docker Compose en Coolify.

| Capa | Tecnología | Motivo |
|---|---|---|
| Frontend | **Next.js (App Router) + React + Tailwind** | Un solo app con dos zonas: `/kiosk` (táctil, pantalla completa) y `/admin` (panel). |
| Backend | **NestJS** (API REST + SSE) | Módulos, inyección de dependencias, guards de permisos, tareas programadas: encaja con "el reloj es un módulo más". |
| Base de datos | **PostgreSQL 16+** | Restricciones de exclusión, índices parciales, triggers, `timestamptz`: las reglas críticas viven en la BD. |
| ORM | **Drizzle** (recomendado) — alternativa Prisma | Ver §3. |
| Validación compartida | **Zod** en `packages/shared` | Mismos esquemas/tipos en API y web. |
| Tiempo real | **SSE** (Server-Sent Events) | Más simple que WebSockets para "el servidor empuja actualizaciones". |
| Excel | `exceljs` en el backend | PDF después (Playwright/Chromium o `pdfmake`). |
| Pruebas | Vitest/Jest + Testcontainers (Postgres real) | Las reglas de asistencia se prueban con casos reales (turno nocturno, etc.). |

### ¿Por qué NestJS y no solo las rutas API de Next.js?
1. **Crecimiento:** mesas, adelantos, nómina, comunicados serán *módulos* con sus propias reglas, jobs y permisos. Nest los organiza naturalmente; en Next quedarían dispersos.
2. **Procesos en segundo plano** (cierre de faltas, jornadas vencidas) necesitan un proceso de larga vida con scheduler: Nest lo da; Next serverless-style, no.
3. **Tiempo real** por SSE/WebSocket con estado en memoria (suscriptores por sucursal) es natural en un servidor Nest.
4. **Múltiples clientes futuros** (kiosco, panel, quizá app móvil/QR) consumen la misma API.
5. **Costo:** un contenedor más. Para tu home lab es marginal.

> Si prefieres menos piezas, es viable un solo Next.js, pero lo desaconsejo por los puntos 2 y 3.

## 2. Estructura del repositorio

```
claude-app-checador/
├─ apps/
│  ├─ api/                    # NestJS
│  │  └─ src/
│  │     ├─ modules/
│  │     │  ├─ core/         # sucursales, empleados, asignaciones, kioscos
│  │     │  ├─ auth/         # login panel, sesión de kiosco, guards, RBAC
│  │     │  ├─ scheduling/   # plantillas, semanas, turnos
│  │     │  ├─ attendance/   # checadas, jornadas, incidencias, correcciones, motor de cálculo
│  │     │  ├─ reports/      # consultas + exportación Excel
│  │     │  ├─ realtime/     # SSE por sucursal
│  │     │  ├─ settings/     # políticas en cascada
│  │     │  └─ audit/        # bitácora
│  │     └─ db/              # esquema Drizzle + migraciones SQL
│  └─ web/                   # Next.js
│     └─ src/app/
│        ├─ kiosk/           # identificación + acciones + mis horarios/asistencias
│        └─ admin/           # panel: tablero, horarios, empleados, correcciones, reportes...
├─ packages/
│  └─ shared/                # zod schemas, enums, tipos, utilidades de fecha
├─ docs/                     # estos documentos
├─ docker-compose.yml        # producción (Coolify)
├─ docker-compose.dev.yml    # desarrollo local
└─ README.md
```
Gestor: **pnpm workspaces** (+ Turborepo opcional).

### Reglas de modularidad (para no enredarlo después)
- Cada módulo expone una **interfaz pública** (servicios/eventos); no se accede a tablas de otro módulo directamente.
- `attendance` consume `scheduling` y `core` por sus servicios.
- Los módulos futuros (`tables`, `advances`, `payroll`, `announcements`) se agregan como carpetas nuevas con su propio esquema Postgres, sin tocar el reloj.
- **Motor de cálculo = función pura** (`evaluateAttendance(events, shift, policy)`), sin acceso a BD ni a `Date.now()`. Es lo más probado del sistema.

## 3. Decisión de ORM: Drizzle vs Prisma

| | Drizzle (recomendado) | Prisma |
|---|---|---|
| Índices parciales, `EXCLUDE`, triggers, vistas | Se escriben en SQL dentro de las migraciones; el esquema TS convive bien | También con SQL manual, pero el esquema declarativo no los representa y genera fricción |
| Esquemas Postgres múltiples | Soportado | Soportado con más ceremonia |
| Transacciones con `SELECT … FOR UPDATE` | Directo | Requiere `$queryRaw` |
| Curva / ecosistema | Menor ecosistema | Más conocido, mejor documentación |

Como el diseño depende de **restricciones y triggers de Postgres** (no solo tablas), prefiero SQL como fuente de verdad de migraciones: Drizzle encaja mejor. Es una decisión reversible en esta etapa; la tomo contigo en `00-decisiones-pendientes.md` **[D-13]**.

## 4. Flujos clave

### 4.1 Checada en kiosco
```mermaid
sequenceDiagram
  participant K as Kiosco (tablet)
  participant API as API (NestJS)
  participant DB as PostgreSQL
  K->>API: POST /kiosk/identify {pin}  (token de dispositivo)
  API->>DB: busca empleado por HMAC(pin) + asignación en esta sucursal
  API-->>K: token corto de sesión + nombre + acciones permitidas
  K->>API: POST /kiosk/punch {type, client_event_id}
  API->>DB: BEGIN; bloquear jornada; validar transición; insertar punch_event;<br/>recalcular jornada; incidencias; auditoría; COMMIT
  API-->>K: confirmación (hora del servidor)
  API-->>Panel: SSE "attendance.updated" (sucursal)
```
- El token de dispositivo viaja en cada petición; la **sucursal sale del dispositivo**.
- La sesión del empleado dura segundos y solo sirve en ese kiosco.
- Dentro de la transacción: bloqueo de fila de la jornada (`SELECT … FOR UPDATE`), validación de la máquina de estados, antirrebote e idempotencia.

### 4.2 Tablero en tiempo real
1. El panel abre `GET /branches/:id/live` (snapshot completo con estados calculados).
2. Abre un stream SSE; cada checada o corrección emite un evento de la sucursal.
3. Cada ~30 s el panel pide un refresco para los estados que cambian solo con el tiempo (retardo, "no se presentó", comida excedida).
4. Con una sola instancia de API, el bus de eventos es en memoria. Si algún día hay varias réplicas, se cambia por `LISTEN/NOTIFY` de Postgres o Redis **sin tocar el resto**.

### 4.3 Corrección de asistencia
Encargado/admin ⇒ crea corrección con motivo ⇒ (aprobación si aplica) ⇒ transacción: nuevas checadas + anulaciones + recálculo + resolución de incidencia + auditoría ⇒ SSE.

### 4.4 Reportes
Consultas SQL sobre `attendance_records` (+ turnos) filtradas por fecha laboral/sucursal/empleado; exportación Excel generada en el servidor y descargada. La exportación queda auditada.

## 5. Autenticación y seguridad

| Actor | Mecanismo |
|---|---|
| Administrador / Encargado | Email + contraseña (argon2id). Sesión por cookie `httpOnly`, `Secure`, `SameSite=Lax`. Rate limit en login. 2FA opcional futuro. |
| Kiosco (dispositivo) | Token largo generado al registrar el kiosco desde el panel; se guarda hasheado; revocable. Se instala una vez en la tablet. |
| Empleado en kiosco | PIN + token de dispositivo ⇒ sesión corta (≈20 s) de solo ese empleado y kiosco. |

- **Autorización:** guard por permiso + alcance de sucursal en cada endpoint. Las consultas SIEMPRE filtran por las sucursales del usuario (no confiar en parámetros del cliente).
- **PIN:** HMAC con pepper en variable de entorno (`PIN_PEPPER`), nunca en BD ni en el repo. Límite de intentos por kiosco.
- **Hora:** solo del servidor; el servidor usa UTC y NTP del host.
- **Secretos** (`PIN_PEPPER`, `SESSION_SECRET`, `DATABASE_URL`) solo como variables de entorno en Coolify.
- **HTTPS** vía el proxy de Coolify (Traefik/Caddy + Let's Encrypt). El kiosco solo funciona por HTTPS.
- **Principio de menor privilegio en BD:** rol `app_user` (sin `DELETE` en tablas de negocio, sin `UPDATE` en tablas solo-agregar) y rol `migrator` aparte.
- **CORS** cerrado al dominio del front; cabeceras de seguridad (helmet), validación de entrada con Zod en cada endpoint.

## 6. Kiosco (UX)

- Ruta `/kiosk`, instalable como **PWA** en pantalla completa/modo quiosco (Android/Chrome, o Fully Kiosk Browser si lo prefieres).
- Pantalla 1: logo Fatboy, nombre de la sucursal, campo de código y teclado numérico grande.
- Pantalla 2: saludo + **solo** los botones permitidos (grandes, un toque) + "Mis horarios / Mi asistencia / Mis incidencias".
- Confirmación breve con hora y regreso automático a la pantalla 1.
- Reloj visible en pantalla (hora del servidor sincronizada) y aviso claro si no hay conexión.
- **Sin conexión (MVP):** no se puede checar y se indica claramente. Plan de contingencia: el encargado registra la checada por corrección con motivo. Modo offline queda como fase futura **[D-12]**.
- Diseñado como **"lanzador del empleado"**: tras el PIN, el menú puede crecer con módulos (mesas, adelantos, comunicados) sin rehacer el login.

## 7. Despliegue en Coolify

Servicios (`docker-compose.yml`):

| Servicio | Imagen | Notas |
|---|---|---|
| `db` | `postgres:16` | Volumen persistente. Alternativamente un recurso PostgreSQL nativo de Coolify (mejor para respaldos programados). |
| `api` | Dockerfile multi-stage (Node LTS slim) | Healthcheck `/health`. Al arrancar: **ejecuta migraciones** y luego inicia. 1 réplica. |
| `web` | Dockerfile multi-stage (Next.js `output: standalone`) | Healthcheck. |

- **Variables de entorno:** `DATABASE_URL`, `PIN_PEPPER`, `SESSION_SECRET`, `TZ=UTC`, `APP_URL`, `API_URL`.
- **Dominios:** p. ej. `checador.tudominio.com` (web) y `api.checador.tudominio.com` (API) o un solo dominio con rutas `/api` por el proxy.
- **Migraciones:** versionadas en el repo, idempotentes, ejecutadas en despliegue. Nunca cambios manuales a la BD.
- **Respaldos:** *crítico* por el valor de la auditoría. Respaldos programados de Coolify (diarios) a un destino **fuera del servidor** (S3/Backblaze/NAS) y **prueba de restauración** periódica.
- **Logs:** JSON estructurado a stdout (Coolify los recoge) con `request_id`.
- **Monitoreo:** healthchecks de Coolify + alerta si el kiosco no reporta (`last_seen_at`).
- **Seed inicial:** migración/seed crea permisos, roles `ADMIN`/`ENCARGADO`, política global y un primer administrador (credenciales por variable de entorno, cambiar al primer login).

## 8. Plan de implementación por fases

| Fase | Entrega | Qué valida |
|---|---|---|
| **0 · Fundaciones** | Monorepo, Docker/Compose, CI, migraciones, auth del panel, RBAC, bitácora de auditoría base | Pipeline de despliegue a Coolify funcionando desde el día 1 |
| **1 · Núcleo** | Sucursales, empleados, PIN, asignaciones, kioscos | Altas y bajas con auditoría |
| **2 · Horarios** | Plantillas, programación semanal, publicar, turnos nocturnos | Reglas RN-HOR |
| **3 · Motor de asistencia** | Kiosco (PIN → acciones), máquina de estados, cálculo, incidencias, jobs | El corazón: RN-EVT, RN-CAL, RN-INC |
| **4 · Tablero en vivo** | SSE, vista del encargado | RN-RT |
| **5 · Correcciones + auditoría** | Flujo de correcciones, visor de auditoría | RN-COR, RN-AUD |
| **6 · Reportes** | Consultas + Excel | RN-REP |
| **7 · Autoservicio del empleado** | Mis horarios/asistencias/incidencias en kiosco | RN-ROL |
| **Después** | PDF, QR/cámara, offline, RH, festivos, módulos nuevos | — |

Cada fase termina desplegable y probada. Las fases 2–3 llevan pruebas automáticas obligatorias del motor (nocturnos, tolerancias, comida, cambios de zona).

## 9. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Caída de internet/servidor en una sucursal | Fase futura de modo offline; mientras, contingencia manual con correcciones. UPS para el servidor/tablet. |
| Compañeros que se prestan el PIN ("checar por otro") | Mejora futura: cámara/foto en cada checada, QR personal o biometría; el diseño de `punch_events` admite adjuntar evidencia. |
| Pérdida de datos | Respaldos fuera del servidor + prueba de restauración. |
| Reglas de negocio ambiguas | Documento de decisiones + pruebas con casos concretos antes de programar. |
| Desfase de hora | Todo UTC desde servidor + NTP; zona por sucursal. |

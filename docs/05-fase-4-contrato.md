# 05 · Fase 4 — Contrato de implementación (APROBADO)

> Aprobado por el dueño sobre el estado `63d6aae` (CI #11 en verde), con las 7 decisiones confirmadas y las precisiones A–G.
> **Estado: implementado** (migraciones `0009`–`0010`, API, panel, kiosco, pruebas Vitest y E2E 53–59). Las decisiones técnicas
> internas están en `00-decisiones.md` § Decisiones técnicas de la Fase 4.
> Las decisiones funcionales quedan registradas como **D-66 … D-77** en `00-decisiones.md`. Si durante la implementación
> aparece una decisión funcional nueva, se consulta; las decisiones técnicas internas que respetan este contrato se
> resuelven con la alternativa más segura y se documentan en `00-decisiones.md` (§ Decisiones técnicas de la Fase 4).

## 1. Objetivo

Cerrar el ciclo de asistencia: reglas pendientes (salida anticipada, sin comida, pausa omitida, anulación automática de
faltas), **solicitudes de corrección con aprobación**, **reportes con exportación**, **tablero en tiempo real (SSE)** y
**control de kioscos**, sin perder ninguna garantía de las Fases 0–3 (RLS, auditoría, eventos físicos inmutables,
aislamiento por `organization_id`, PostgreSQL como última línea de defensa).

## 2. Alcance

| # | Entregable |
|---|---|
| A | FALTA anulada automáticamente (`VOIDED`, nunca borrada) si el turno se cancela, se reasigna o se reprograma a futuro (D-66) |
| B | `SALIDA_ANTICIPADA` con `exit_tolerance_min` (D-67) |
| C | `SIN_COMIDA` con `require_break` + `break_required_after_min` (D-68) |
| D | Corrección `ADD_BREAK` (pausa omitida) sin evento físico (D-69) |
| E | `CREATE_SESSION` genera `SIN_TURNO_PROGRAMADO` solo si no hay turno (D-72) |
| F | Solicitudes de corrección: kiosco (cualquier empleado, con PIN) y panel (miembro con ficha); aprobar/rechazar/cancelar (D-70, D-71) |
| G | Reportes: resumen por empleado, detalle de jornadas, incidencias, correcciones/solicitudes (D-73) |
| H | Periodos rápidos Hoy · Ayer · Semana · Quincena · Mes (actual / anterior) · Rango (D-73) |
| I | Exportación XLSX y CSV auditada (D-74) |
| J | SSE del tablero y de la bandeja de solicitudes, polling como respaldo (D-75) |
| K | Kioscos: `activated_at`, `last_seen_at`, estado y revocación inmediata (D-76) |
| L | Aislamiento SaaS de todo lo nuevo (D-77), pantallas, pruebas, E2E, documentación y CI |

## 3. Fuera de alcance

PDF · nómina/pagos/horas extra/periodos de pago · notificaciones por correo/push · cuenta web para todos los empleados ·
aprobación multinivel · aprobar "con ajuste" o editar una solicitud · reportes programados/por correo · gráficas · modo
offline · reprocesos masivos por cambio de política · geolocalización/biometría/QR · facturación SaaS · vacaciones y festivos.

## 4. Decisiones confirmadas por el dueño

1. **Canal del empleado:** kiosco para cualquier empleado mediante PIN; panel solo para quien ya tenga cuenta con ficha de
   empleado vinculada. Sin cuenta web para todos.
2. **Sin "aprobar con ajuste":** la solicitud se aprueba EXACTAMENTE como fue enviada o se rechaza. No hay tercer estado ni
   edición por el aprobador; si se requieren otros valores, se rechaza y quien tenga permiso aplica una corrección directa.
3. `correction_request_window_days = 7`; `max_pending_correction_requests = 3`.
4. `break_required_after_min`: default de plataforma **0**; **Fatboy: override de negocio 360** (SIN_COMIDA solo en jornadas
   reales de 6 h o más, cuando `require_break = true`).
5. `exit_tolerance_min` de **Fatboy = 5** (hasta 5 min antes no genera incidencia; más de 5 sí). Configurable por política.
6. ENCARGADO recibe por defecto `attendance.correction.request` (revocable por negocio). Nadie aprueba su propia solicitud.
7. Reportes: rango máximo **366 días**; exportación máxima **100 000 filas**; **10 exportaciones por minuto por usuario**.

> **Cómo se configura Fatboy (4 y 5):** RN-ORG-09 prohíbe dejar "Fatboy" fijo en el código o en migraciones, así que los
> valores se aplican como **override de política del negocio** (`ORGANIZATION`): desde el panel (Políticas) o con el CLI de
> plataforma `platform set-policy --slug fatboy --param breakRequiredAfterMin=360 --param exitToleranceMin=5`
> (documentado en `04-operacion.md` como parte del alta de Fatboy; el E2E lo aplica igual).

## 5. Precisiones aprobadas (A–G)

**A. Ventana de 7 días por DÍA OPERATIVO.** Toda solicitud guarda el `operational_date` de su objetivo: el de la jornada; el
`business_date` del turno; o, para `CREATE_SESSION` sin turno, el día operativo de la hora de inicio propuesta (zona IANA y
hora de corte efectivas de la sucursal). Se acepta si `0 ≤ (día operativo actual de esa sucursal − operational_date) ≤ 7`,
donde el día operativo actual se calcula con la zona y el corte de la sucursal. No depende de `created_at` ni de restar
168 h. Un trigger verifica que el `operational_date` guardado coincida con el de la jornada referida.

**B. Unicidad real de "una solicitud pendiente igual" en PostgreSQL.** Por acción, con columnas obligatorias por `CHECK`
(sin `NULL` en las columnas del índice) e índices únicos parciales:

| Acción | Columnas obligatorias | Índice único parcial (`status = 'PENDING'`) |
|---|---|---|
| `SET_CLOCK_IN`, `SET_CLOCK_OUT` | `work_session_id`, `proposed_start` | `(organization_id, work_session_id, action)` |
| `SET_BREAK_START`, `SET_BREAK_END` | `work_session_id`, `break_id`, `proposed_start` | `(organization_id, break_id, action)` |
| `ADD_BREAK` | `work_session_id`, `proposed_start`, `proposed_end` | `(organization_id, work_session_id)` |
| `CREATE_SESSION` con turno | `shift_id`, `proposed_start`, `proposed_end` (sin jornada) | `(organization_id, shift_id)` |
| `CREATE_SESSION` sin turno | `operational_date`, `proposed_start`, `proposed_end` (sin jornada ni turno) | `(organization_id, employee_id, operational_date)` |

**C. `CREATE_SESSION` ligada a turno.** Conserva explícitamente `shift_id`. Al aprobar se vuelve a comprobar, en la misma
transacción y con el turno bloqueado: que siga `SCHEDULED` en un horario `PUBLISHED`, del mismo empleado y sucursal, y sin
jornada. Si hay una FALTA abierta válida de ese turno, se resuelve como `CORRECTED`. Si el turno fue cancelado,
reasignado o dejó de ser oficial, la aprobación falla y **no** se modifica la solicitud ni se crea la jornada. Sin turno:
se genera `SIN_TURNO_PROGRAMADO` (D-72).

**D. Snapshot de políticas.** Las jornadas nuevas congelan en `policy_snapshot`: `requireBreak`, `breakRequiredAfterMin`,
`breakAllowedMin` (minutos permitidos por pausa), `breakToleranceMin`, `entryToleranceMin`, `exitToleranceMin` (además de los
de la Fase 3). Los recálculos usan SIEMPRE el snapshot; solo las jornadas históricas sin un valor usan la política actual
(fallback documentado).

**E. SSE = invalidación.** Los eventos solo llevan identificadores mínimos (tipo, id, sucursal, operación), sin datos
personales. El cliente vuelve a consultar por los endpoints normales con RBAC/RLS. Perder un `NOTIFY` nunca afecta la
consistencia: SSE es optimización visual, no fuente de verdad (además hay recarga periódica y polling de respaldo).

**F. `VOIDED` en reportes.** Una FALTA anulada no cuenta como falta real en los totales operativos, pero sigue visible en el
historial y en el reporte de incidencias (con su resolución y motivo). Nada se borra ni se oculta.

**G. Seguridad de "Mis registros" en el kiosco.** Pase temporal y datos mínimos; 20 s de inactividad; al terminar, cancelar o
expirar se limpia todo el estado del empleado en el cliente; no se puede volver atrás para recuperar los registros del
empleado anterior (sin historial del navegador, sin estado residual en memoria/UI).

## 6. Migraciones

- `0009_attendance_phase4.sql`: tipos `SALIDA_ANTICIPADA`, `SIN_COMIDA`; resolución `VOIDED`; `resolution_source`;
  unicidad de FALTA solo entre no anuladas; guarda de FALTA; anulación automática al cancelar o reasignar; acción
  `ADD_BREAK`; `correction_requests` (+ triggers); `corrections.request_id`; políticas `break_required_after_min`,
  `correction_request_window_days`, `max_pending_correction_requests`; permiso de solicitud para ENCARGADO; triggers `NOTIFY`.
- `0010_kiosk_monitoring.sql`: `activated_at`, `last_seen_ip`; relleno de `activated_at` para kioscos ya usados.

## 7. Modelo (resumen)

- `attendance.incidents`: `type` + `SALIDA_ANTICIPADA`, `SIN_COMIDA`; `resolution` + `VOIDED`; `resolution_source`
  (`USER`/`CORRECTION`/`SYSTEM`, nulo mientras está abierta; `VOIDED ⇔ SYSTEM`, `CORRECTED ⇔ CORRECTION`); una FALTA no
  anulada por turno; trigger `guard_falta_insert`.
- `attendance.corrections`: `action` + `ADD_BREAK`; `request_id` (FK compuesta, única).
- `attendance.correction_requests`: ver §5-B; `channel` (`KIOSK`/`PANEL`) con `requested_device_id` / `requested_by_user_id`;
  idempotencia por `client_request_id`; `status` `PENDING → APPROVED | REJECTED | CANCELLED` (terminales inmutables);
  `decided_by`, `decided_at`, `decision_reason` (obligatorio al rechazar), `correction_id` (obligatorio al aprobar);
  `session_version_at_request`; `version`. Triggers: transición, contenido inmutable, nadie decide su propia solicitud,
  coherencia del día operativo. RLS forzado; `app_user` sin `DELETE` y `UPDATE` solo en columnas de decisión.
- `core.kiosk_devices`: `activated_at`, `last_seen_ip`; `last_seen_at` se actualiza a lo más una vez por minuto.
- Políticas: `break_required_after_min` (0, 0–1440, todos los niveles), `correction_request_window_days` (7, 1–31,
  negocio·sucursal), `max_pending_correction_requests` (3, 1–20, negocio).
- Avisos: `AFTER INSERT OR UPDATE` en `work_sessions`, `breaks`, `incidents`, `correction_requests` ⇒
  `pg_notify('att_<organization_id sin guiones>', {k, id, b, op})`.

## 8. Permisos

Sin permisos nuevos: `attendance.correction.request` (panel, propia ficha; ENCARGADO por defecto), `attendance.correction.apply`
(aprobar/rechazar y corregir, en la sucursal donde ocurrió), `attendance.view` (bandeja, SSE), `reports.view` / `reports.export`,
`kiosks.manage`. En el kiosco el derecho es implícito: el empleado identificado por PIN sobre sus propias jornadas.

## 9. Endpoints

Kiosco (pase en el cuerpo, nunca en la URL): `POST /api/kiosk/my-records`, `POST /api/kiosk/correction-requests`,
`POST /api/kiosk/correction-requests/:id/cancel`.
Panel: `GET /api/attendance/correction-requests` (+ `/summary`), `GET …/:id`, `POST /api/attendance/correction-requests`,
`POST …/:id/approve` `{expectedVersion, expectedSessionVersion}`, `POST …/:id/reject` `{expectedVersion, reason}`,
`POST …/:id/cancel`, `GET /api/attendance/my/sessions`, `POST /api/attendance/sessions/:id/corrections` (+ `ADD_BREAK`),
`GET /api/attendance/stream` (SSE).
Reportes: `GET /api/reports/periods`, `GET /api/reports/attendance?report=summary|sessions|incidents|corrections&…`,
`POST /api/reports/export` `{report, format: xlsx|csv, filters}`.
Kioscos: `GET /api/kiosks` con `activatedAt`, `lastSeenAt`, `state`.

## 10. SSE

`ready` (el cliente recarga todo) · `attendance.session` · `attendance.incident` · `attendance.request` · `ping` (25 s).
Una conexión `LISTEN` por proceso; `LISTEN` por negocio solo mientras haya suscriptores; filtrado por sucursal del alcance;
revalidación de sesión/permisos cada 60 s; vida máxima 30 min; 5 conexiones por usuario; `resync` si se pierde la conexión
`LISTEN`. Respaldo: error o 60 s sin `ping` ⇒ polling 30 s y reintento con espera creciente. El proxy del panel reenvía
`text/event-stream` por streaming.

## 11–12. Solicitudes y aprobación

Kiosco: PIN → "Mis registros" (jornadas y faltas de la ventana, datos mínimos) → elegir acción → hora(s) y motivo → solicitud
idempotente. Panel: igual desde "Mis jornadas". Aprobar: bloquea solicitud y jornada (o turno), verifica `PENDING`, versiones,
alcance y que el aprobador no sea el solicitante, ejecuta la corrección con el MISMO código de la corrección directa,
inserta la corrección con `request_id`, marca `APPROVED`, audita y avisa. Si la corrección no es válida, nada cambia y la
solicitud sigue `PENDING`. Rechazar: motivo obligatorio. Cancelar: solo el solicitante, mientras esté `PENDING`.

## 13–16. Reglas

- **SALIDA_ANTICIPADA (D-67):** al cerrar una jornada con turno, `minutos(ends_at → salida efectiva) < −exit_tolerance_min`.
  Se recalcula con correcciones; no aplica sin turno, sin salida ni a la salida tarde.
- **SIN_COMIDA (D-68):** al cerrar, `require_break` y cero pausas cerradas y duración real ≥ `break_required_after_min`.
  `ADD_BREAK` la resuelve. No afecta horas.
- **ADD_BREAK (D-69):** dentro de la jornada, sin cruzarse con otras pausas, sin horas futuras, sin pausa abierta; puede
  exceder `max_breaks` (queda en la auditoría); sin evento físico; recalcula exceso y SIN_COMIDA.
- **FALTA anulada (D-66):** cancelado ⇒ `SHIFT_CANCELLED: <motivo>`; reasignado (empleado o sucursal) ⇒ `SHIFT_REASSIGNED`;
  reprogramado y ahora termina en el futuro ⇒ `SHIFT_RESCHEDULED`. Una FALTA ya resuelta no se toca.

## 17–18. Reportes y exportación

Ver D-73 y D-74 en `00-decisiones.md`. Fuente: valores efectivos; alcance por la sucursal donde ocurrió; lectura en
transacción `REPEATABLE READ`; `VOIDED` fuera de los totales y visible en incidencias (F). XLSX (hoja del reporte + hoja
"Parámetros") y CSV (UTF-8 con BOM, RFC 4180, neutralización de fórmulas); generados al momento sin guardarse; auditados con
filtros y conteo de filas; límites de 366 días, 100 000 filas y 10 por minuto por usuario.

## 19–20. Kioscos y pantallas

Kioscos: estado derivado (Sin credencial · Pendiente de activar · Activo · Inactivo), activación y último uso, "Revocar ahora".
Pantallas: Reportes, Solicitudes, Mis jornadas, kiosco "Mis registros / Solicitar corrección"; modificadas: Asistencia en vivo
(SSE), Detalle de jornada (agregar pausa, solicitudes), Incidencias, Kioscos, Inicio (pendientes).

## 21–26. Estados, concurrencia, auditoría, seguridad, aislamiento y casos límite

Según la propuesta aprobada (resumen en `00-decisiones.md` y en la sección técnica de la Fase 4).

## 27–29. Pruebas

Matriz por D-66 … D-77 (Vitest contra PostgreSQL real) y E2E 53–59: solicitud en kiosco → aprobación → historial; rechazo y
"no autoaprobación"; SSE con respaldo por polling; reportes y descarga XLSX/CSV; FALTA anulada al cancelar; pausa omitida;
monitoreo y revocación de kioscos. Ninguna prueba existente se elimina.

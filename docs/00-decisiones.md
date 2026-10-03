# 00 · Registro de decisiones

Todas las decisiones funcionales actuales están **cerradas** (reglas v1.5 y modelo v1.5 congelados; D-1 … D-78). Contrato de la Fase 4: `05-fase-4-contrato.md`. Un cambio posterior se anota aquí con fecha y motivo.

| # | Decisión | Reglas |
|---|---|---|
| **D-1** | **Zona horaria obligatoria al crear cada negocio** (sin default fijo; Fatboy = `America/Tijuana`). Las sucursales heredan la del negocio y pueden sobrescribirla. En BD todo en UTC; la zona se usa para interpretar turnos, cortes, retardos, reportes y días operativos. | RN-SUC-01..03 |
| **D-2** | Las pausas/comidas son solo control de tiempo e incidencias; no descuentan horas ni afectan pagos/nómina. | RN-CAL-02 |
| **D-3** | Se registran los minutos reales de retardo; la tolerancia solo decide si genera incidencia. | §9 |
| **D-4** | Estados de llegada separados: A tiempo · Retardo/Aún no llega · Ausente/No ha llegado (tras `absent_after_min`, no definitivo) · Trabajando (conserva retardo real) · Falta (solo al terminar el turno sin Entrada). Un retardo con Entrada real **nunca** se vuelve falta. `absent_after_min` configurable por negocio y opcionalmente sucursal. | RN-INC-06, RN-CAL-01 |
| **D-5** | Entrada anticipada: 60 min por defecto, política configurable por negocio/sucursal; se guarda siempre la hora real; fuera de ventana y sin otro turno ⇒ `SIN_TURNO_PROGRAMADO`. | RN-EVT-05/06 |
| **D-6** | Checada sin turno programado: se permite y se marca para revisión. | RN-EVT-06 |
| **D-7** | El encargado corrige directamente (alcance, motivo obligatorio, auditoría, original intacta). | RN-COR-* |
| **D-8** | PIN de 6 dígitos generado por el sistema; hash (nunca texto plano); se muestra una vez; no lo cambia el empleado; restablecer invalida el anterior; auditoría sin PIN; protección contra intentos masivos; único por negocio (puede repetirse entre negocios). | RN-PIN-* |
| **D-9** | Jornada abierta = incidencia + corrección; el sistema nunca inventa una salida; corte operativo configurable (parámetro heredable). | RN-OPE-* |
| **D-10** | Semana lunes–domingo (configurable por negocio); reportes con accesos rápidos (Hoy, Ayer, Esta semana, Semana pasada, 1–15, 16–fin, Este mes, Mes pasado, Personalizado). Sin entidad "periodo de pago"; el diseño no impide agregar nómina después. | RN-REP-02/06 |
| **D-11** | Identidad y credenciales pertenecen a la plataforma. El admin del negocio activa/desactiva/quita la **membresía**; no ve ni cambia la contraseña global. Restablecimiento global por plataforma. Recuperación por correo: fase posterior (modelo preparado). | RN-IDN-* |
| **D-12** | MVP exige internet ("Sin conexión" + corrección manual con motivo). Modelo **preparado para offline**: `client_event_id`, `device_id`, `occurred_at`, `received_at`, `source`, `time_source`, idempotencia, auditoría. | RN-EVT-12/13 |
| **D-13** | **Drizzle + PostgreSQL**; las reglas importantes (RLS, constraints, índices, triggers) también en PostgreSQL; migraciones SQL como fuente de verdad. | Principio 10 |
| **D-14** | Pausas como **registros independientes** (`attendance_breaks`); política `max_breaks` (1) y `break_allowed_min` (35) por pausa; duración y exceso por pausa y acumulado; 2 pausas sin cambiar el modelo. | RN-EVT-03, §8 modelo |
| **D-15** | Cuenta de panel y ficha de empleado separadas; ligadas opcionalmente en la membresía. | RN-EMP-05 |
| **D-16** | UI en español con sistema de traducciones desde el inicio; código, tablas, columnas y enums en inglés. | RN-I18N-* |
| **D-17** | Checar en otra sucursal del mismo negocio sin asignación: se permite y se marca `SIN_ASIGNACION_SUCURSAL`. El kiosco no puede cruzar negocios. | RN-SUC-06 |
| **D-18** | Nadie corrige su propia jornada; el encargado corrige jornadas ocurridas en sus sucursales; el admin, dentro de su negocio. | RN-COR-04..06 |
| **D-19** | Identidad global + membresías; elige negocio si tiene varios; contexto fijado en sesión; PIN único por negocio; negocios por script interno; sin subdominios; token de kiosco = `organization_id + branch_id + device_id`; el frontend nunca decide el `organization_id`. | RN-ORG-*, RN-IDN-* |
| **D-20** | **Jerarquía de políticas Plataforma → Negocio → Sucursal → Empleado**; solo overrides; política efectiva calculada; aplica a tolerancia, entrada anticipada, pausas, corte operativo y futuras políticas heredables. | RN-CFG-* |

| **D-21** | **Protección del PIN sin inutilizar el kiosco compartido.** Pausa por `device_id`: 5 fallos consecutivos → 10 s; los siguientes duplican la pausa (20, 40, 80…) con **tope global de 120 s** (configurable, máximo 300 s; nunca 1 h). Un acierto reinicia el contador. Cada pausa queda en auditoría como `security.pin_pause_started`. Parámetros `pin_max_attempts`, `pin_lockout_sec`, `pin_lockout_max_sec` (negocio/sucursal). Valor indexable del PIN = `HMAC-SHA256(PIN_PEPPER, organization_id + ":" + pin)`; nunca en texto plano ni en logs. | RN-PIN-03, RN-PIN-08 |

| **D-22** | **Horario ≠ turno concreto.** El turno concreto (empleado, sucursal, fecha, instantes reales) es la fuente de verdad para asistencia; nunca se calcula contra una plantilla. | RN-HOR-01 |
| **D-23** | **Plantillas separadas** de los turnos; editarlas nunca cambia turnos históricos ni publicados. MVP: **copiar semana anterior**; arquitectura lista para recurrencias. | RN-HOR-05 |
| **D-24** | Horario semanal `DRAFT` → `PUBLISHED` (acción explícita, irreversible). Publicados: se editan/cancelan con auditoría; nunca hard delete. | RN-HOR-04 |
| **D-25** | Estado del turno solo `SCHEDULED` / `CANCELLED`; nada de estados de asistencia. | RN-HOR-13 |
| **D-26** | `starts_at`/`ends_at` en UTC + `timezone_snapshot`; la API trabaja con hora local y la zona efectiva de la sucursal; cambiar la zona después no reinterpreta turnos. | RN-HOR-11 |
| **D-27** | Turnos nocturnos = un solo turno; `ends_at > starts_at`; pertenecen al día en que inician. | RN-HOR-09 |
| **D-28** | DST con zonas IANA; hora inexistente ⇒ error; ambigua ⇒ elegir `EARLIER`/`LATER`; nunca otra hora en silencio. | RN-HOR-10 |
| **D-29** | Sin traslapes del mismo empleado entre sucursales; exclusión en PostgreSQL con `[inicio, fin)`. | RN-HOR-03 |
| **D-30** | ADMIN programa todo su negocio; ENCARGADO solo sus sucursales y empleados asignados a ellas. La planificación es estricta (D-17 solo aplica al kiosco). | RN-HOR-08 |
| **D-31** | Cambios a turnos publicados auditados (antes/después, usuario, fecha, negocio, sucursal); motivo obligatorio solo al cancelar. | RN-HOR-07 |
| **D-32** | Futuro: edición normal. En curso o terminado (y crear en el pasado): solo con `schedules.history.manage` (ADMIN) y motivo. Planificación ≠ asistencia. | RN-HOR-12 |

| **D-33** | Un turno de un horario `PUBLISHED` nunca vuelve implícitamente a borrador: moverlo a otra sucursal o semana exige que el horario destino exista y esté `PUBLISHED` (si no, `SHIFT_TARGET_SCHEDULE_NOT_PUBLISHED`). En borradores sí se crea el destino en `DRAFT`. Sin estado de publicación en el turno: la semántica vive en el horario. Servicio + trigger. | RN-HOR-07 |
| **D-34** | Solo turnos `SCHEDULED` de un horario `PUBLISHED` cuentan para asistencia. Un borrador no existe operativamente (si el empleado checa ⇒ `SIN_TURNO_PROGRAMADO`; no se le muestra). La jornada guarda `shift_id` (nullable por D-6). | RN-ASI-01 |
| **D-35** | Matching de la Entrada: mismo negocio, empleado y sucursal del kiosco, turno oficial; ventana `inicio − early_entry_window_min` (60) … fin del turno. Después del fin ya no se liga. Sin turno válido ⇒ jornada sin turno (D-6). Nunca turnos de otra sucursal. | RN-ASI-02 |
| **D-36** | Programado en otra sucursal y checa aquí: jornada en la sucursal real, `shift_id = null`, `SIN_ASIGNACION_SUCURSAL` si no está asignado y marca informativa `TURNO_EN_OTRA_SUCURSAL`. No se bloquea (D-17). | RN-ASI-03 |
| **D-37** | Jornada real (`work_session`): negocio, sucursal, empleado, turno (nullable), inicio, fin (nullable), día operativo, estado, origen, incidencias, versión, auditoría. Sin valores derivados guardados. Nunca modifica el turno. *Shift = lo que debía trabajar; WorkSession = lo que ocurrió.* | RN-ASI-04 |
| **D-38** | Eventos físicos `CLOCK_IN`/`BREAK_START`/`BREAK_END`/`CLOCK_OUT` inmutables con la infraestructura D-12 (`client_event_id`, `device_id`, `occurred_at`, `received_at`, `source`, idempotencia) y relación con negocio, sucursal, empleado y jornada. Una corrección no altera el evento. | RN-ASI-05 |
| **D-39** | Acciones del kiosco según la jornada: sin jornada ⇒ Entrada; abierta ⇒ Salida a comer + Salida; en pausa ⇒ Regreso de comer. Nunca acciones imposibles; las inconsistencias van a corrección administrativa. | RN-ASI-06 |
| **D-40** | Una sola jornada abierta por empleado en el negocio, también en PostgreSQL; en otra sucursal el kiosco reconoce la existente. | RN-ASI-07 |
| **D-41** | La Entrada ligada guarda/calcula la diferencia real completa contra `starts_at` (con signo); la tolerancia solo decide `RETARDO`. | RN-ASI-08 |
| **D-42** | Llegada anticipada dentro de la ventana: se liga y se guarda la hora real (sin redondear). | RN-ASI-08 |
| **D-43** | Estados derivados: dentro de tolerancia · Retardo/aún no llega · Ausente/no ha llegado (desde `absent_after_min`) · Trabajando (conserva el retardo) · Falta solo si el turno termina sin Entrada válida. | RN-ASI-09 |
| **D-44** | Al terminar un turno publicado sin Entrada ⇒ incidencia `FALTA` (negocio, sucursal, empleado, turno, fecha) por un servicio de reconciliación ejecutable e idempotente; resoluble sin borrar. | RN-ASI-10 |
| **D-45** | Corte operativo de Fatboy = 05:00 (valor de plataforma heredado; las sucursales lo heredan salvo override). | RN-OPE-01 |
| **D-46** | Día operativo: con turno = fecha local de inicio del turno; sin turno = hora local de la sucursal y el corte (03:30 ⇒ día anterior; 05:15 ⇒ día actual). Zona IANA efectiva. | RN-ASI-11 |
| **D-47** | Jornada con turno abierta al primer corte posterior al fin ⇒ `SALIDA_OLVIDADA` + requiere corrección. Nunca se inventa la salida. | RN-OPE-04 |
| **D-48** | Jornada sin turno abierta más de `max_open_session_minutes` (960) ⇒ sigue abierta, requiere corrección e incidencia; sin salida inventada. | RN-OPE-04 |
| **D-49** | Pausas como registros independientes (D-14); Fatboy 1 pausa de 35 min; guardar inicio, fin, duración y exceso individual; acumulados calculados. Sin efecto en horas, sueldo ni nómina. | RN-CAL-02 |
| **D-50** | Pausa abierta: no se inventa el regreso; para marcar Salida primero "Regreso de comer"; la corrección resuelve los casos reales. | RN-EVT-08 |
| **D-51** | Corrección de asistencia = módulo separado; nunca modifica turnos. ENCARGADO: jornadas ocurridas en sus sucursales, no la propia; ADMIN: todo el negocio. Motivo obligatorio; original, corregido, usuario, fecha, antes/después. | RN-COR-* |
| **D-52** | Sin `UPDATE` destructivo sobre el evento físico: estructura de correcciones; reportes con el valor efectivo; auditoría con ambos. | RN-COR-03 |
| **D-53** | Corregir una falta: crear/corregir la jornada y marcar la incidencia como resuelta por corrección, conservando el historial. | RN-COR-08 |
| **D-54** | Toda acción del kiosco es idempotente por `device_id + client_event_id`; un reintento responde lo mismo. | RN-EVT-12 |
| **D-55** | Concurrencia: dos Entradas simultáneas no crean dos jornadas; igual para pausas y Salida. Invariantes en PostgreSQL. | RN-EVT-01 |
| **D-56** | Kiosco con credencial de dispositivo propia (no la sesión administrativa); activación pegando el token una vez; el servidor establece una cookie segura; revocado/desactivado deja de funcionar. Nada permanente en `localStorage`. | RN-PIN-09 |
| **D-57** | Pantalla táctil a pantalla completa: negocio, sucursal, reloj, PIN con teclado grande, borrar, confirmar; luego nombre, acciones, turno y hora; confirmación grande y regreso automático sin datos del anterior. | RN-ASI-12 |
| **D-58** | PIN enmascarado; nunca en logs, errores, auditoría, analítica, URLs o query strings; se mantiene D-21. | RN-PIN-* |
| **D-59** | Al empleado solo: su nombre, sucursal, turno actual/próximo, acción y confirmación. | RN-ASI-12 |
| **D-60** | Tablero de asistencia por sucursal con estados derivados (programados, no llegan, retardos, ausentes, trabajando, en comida, con problema, salidas, faltas). | RN-RT-* |
| **D-61** | Historial por empleado: día operativo, sucursal, turno, Entrada/Salida reales, diferencia, pausas, exceso, incidencias, correcciones y quién corrigió. Programado ≠ Real. | RN-REP-04 |
| **D-62** | Un turno `CANCELLED` no genera retardo, ausencia ni falta ni se liga; si llega igual ⇒ jornada sin turno. | RN-ASI-01 |
| **D-63** | Un turno en semana `DRAFT` no aparece al empleado ni genera ausencia/falta/retardo ni se liga. | RN-ASI-01 |
| **D-64** | Duración real = salida efectiva − entrada efectiva; las pausas se reportan aparte; nada se descuenta automáticamente. | RN-CAL-* |
| **D-65** | Diferencia salida efectiva − `ends_at` (con signo) para reportes; sin sanciones automáticas. | RN-CAL-* |

| **D-66** | **FALTA anulada por el plan.** Si el turno de una FALTA abierta se cancela, se reasigna (empleado o sucursal) o se reprograma y ahora termina en el futuro, la FALTA pasa a `RESOLVED` con `resolution = VOIDED`, `resolution_source = SYSTEM` y motivo de sistema (`SHIFT_CANCELLED: <motivo>`, `SHIFT_REASSIGNED`, `SHIFT_RESCHEDULED`), con auditoría. Nunca se borra; una FALTA ya resuelta no se toca. *Complementa D-44 y RN-INC-03.* | RN-INC-03 |
| **D-67** | **`SALIDA_ANTICIPADA`**: al cerrar una jornada con turno, salida efectiva antes de `ends_at − exit_tolerance_min` (minutos truncados) ⇒ incidencia con los minutos reales. Solo control, sin sanción. Fatboy: `exit_tolerance_min = 5` (override del negocio). *Implementa RN-CAL/RN-INC-01 pendiente.* | RN-INC-01 |
| **D-68** | **`SIN_COMIDA`**: al cerrar, si `require_break` y no hubo pausas cerradas y la duración real ≥ `break_required_after_min` (política nueva: 0 de plataforma; Fatboy 360). No afecta horas ni nómina. *Precisa RN-CAL-04.* | RN-CAL-04 |
| **D-69** | **Pausa omitida** = corrección `ADD_BREAK` (inicio, fin, motivo, usuario, antes/después, auditoría), sin evento físico; puede exceder `max_breaks`. | RN-COR-02 |
| **D-70** | **Solicitudes de corrección**: el empleado solicita (kiosco con PIN; panel solo con cuenta y ficha), nunca modifica. Acciones: Entrada, Salida, inicio/fin de pausa, pausa omitida, jornada no registrada (con o sin turno). Ventana de 7 días por día operativo y máximo 3 pendientes (políticas). Unicidad de pendientes garantizada en PostgreSQL por acción. *Implementa RN-COR-07; RN-COR-01 se mantiene.* | RN-COR-07 |
| **D-71** | **Aprobar o rechazar**: ENCARGADO con alcance en la sucursal donde ocurrió o ADMIN; nunca el propio solicitante (servicio + trigger). Se aprueba EXACTAMENTE lo solicitado (sin ajuste ni edición) o se rechaza con motivo; si hace falta otro valor, se rechaza y se corrige directo. Aprobar ejecuta la corrección con las mismas validaciones; si la jornada cambió desde la revisión ⇒ 409. | RN-COR-07 |
| **D-72** | **`CREATE_SESSION`**: sin turno genera `SIN_TURNO_PROGRAMADO` (y `SIN_ASIGNACION_SUCURSAL` si aplica); con turno conserva `shift_id`, revalida que siga oficial y del empleado, resuelve su FALTA como `CORRECTED` y no genera `SIN_TURNO_PROGRAMADO`. *Ajusta la decisión técnica de la Fase 3 sobre `CREATE_SESSION`.* | RN-COR-08 |
| **D-73** | **Reportes**: resumen por empleado, detalle de jornadas, incidencias, correcciones/solicitudes. Periodos Hoy · Ayer · Semana · Quincena · Mes (actual/anterior) · Rango, calculados por día operativo en la zona de la sucursal (o del negocio). Valores efectivos; confirmadas vs justificadas; `VOIDED` fuera de totales pero visible en el historial. Rango máx. 366 días. *Cubre D-10.* | RN-REP-* |
| **D-74** | **Exportación XLSX y CSV**: al momento, sin guardar archivos; hoja de parámetros; neutralización de fórmulas; máx. 100 000 filas; 10 por minuto por usuario; auditada (filtros y conteo, nunca datos). | RN-REP-05 |
| **D-75** | **Tiempo real (SSE)**: eventos de invalidación sin datos personales; el cliente recarga por los endpoints con RBAC/RLS; canal por negocio; polling de respaldo. Perder un aviso no afecta la consistencia. | RN-RT-* |
| **D-76** | **Kioscos**: `activated_at`, `last_seen_at`, estado del dispositivo y revocación inmediata; la cookie larga no da acceso sin la validación del servidor en cada petición. | RN-PIN-09 |
| **D-78** | **Un solo día operativo para toda la asistencia** (ajusta D-27 y D-46 en lo que toca a asistencia). Mientras no llega la hora de corte del negocio/sucursal (política `operational_cutoff`, en su zona IANA efectiva; Fatboy: America/Tijuana, 05:00), todo pertenece al día operativo ANTERIOR: 02-oct 23:30 ⇒ 02-oct · 03-oct 01:30 ⇒ 02-oct · 03-oct 04:59:59 ⇒ 02-oct · 03-oct 05:00:00 ⇒ 03-oct. El **turno** pertenece al día operativo de su inicio (`shifts.operational_date`); una jornada ligada a un turno, al del turno; una jornada sin turno, al de su Entrada; la FALTA y las solicitudes, al de su turno o jornada. Aplica a asistencia en vivo, jornadas, incidencias, reconciliación, solicitudes y correcciones, reportes, exportaciones y todo filtro "hoy". **Nunca cambian los instantes reales**, solo la fecha con la que se agrupa y consulta. La hora de corte nunca está fija en el código. `business_date` queda solo como fecha de planeación (columna del horario semanal). | RN-ASI-11, RN-ASI-20, RN-RT-01, RN-REP-01 |
| **D-77** | **Aislamiento SaaS** de todo recurso nuevo (tablas, endpoints, consultas, reportes, SSE, exportaciones): `organization_id` + FKs compuestas + RLS + verificación de catálogo + pruebas A↔B. | RN-ORG-* |

## Decisiones técnicas de D-78 (día operativo canónico)

- **Una sola definición:** `src/common/operational-day.ts` (`operationalDate`, `operationalDayWindow`, `cutoffInstant`, `firstCutoffAfter`). Una prueba de arquitectura falla si aparece otra definición o si asistencia/reportes vuelven a usar `businessDate`.
- **Un solo calendario:** `PoliciesService.calendarTx` → `organizationCalendars` resuelve zona (sucursal → negocio) y corte (sucursal → negocio → plataforma) con la misma jerarquía de políticas (`resolvePolicy`). Filtra por `organization_id`, así que también lo usa el CLI de plataforma.
- **Día operativo del turno guardado** (`scheduling.shifts.operational_date`, migración `0011`): se calcula al crear, editar, copiar o generar desde plantilla. `business_date` no cambia de significado (planeación: columna y semana del horario, D-27), para no mover turnos entre semanas/horarios publicados.
- **PostgreSQL lo garantiza:** una jornada ligada tiene el día de su turno (`SESSION_DATE_MISMATCH`); una FALTA, el de su turno (`INCIDENT_DATE_MISMATCH`); una solicitud, el de su turno o jornada (`REQUEST_DATE_MISMATCH`, ahora contra `operational_date`).
- **Un turno con jornada real no cambia de día operativo** (`SHIFT_HAS_ATTENDANCE`, igual que ya no cambiaba de empleado ni de sucursal): así nunca se reescriben jornadas ni incidencias históricas. Si un turno sin jornada cambia de día operativo, su FALTA abierta se anula (`SHIFT_RESCHEDULED`) y la reconciliación genera la correcta.
- **Cambio de hora de corte o de zona:** recalcula el día operativo de los turnos que **aún no empiezan** (panel, CLI y cambio de zona de sucursal); lo ya ocurrido conserva su día (los cambios de política aplican hacia adelante). Las jornadas sin turno conservan el corte congelado en su snapshot.
- **Migración `0011`:** rellena turnos con la gemela SQL `core.operational_date` (solo para migraciones; una prueba verifica que coincide con la función canónica en fronteras, DST y varias zonas) y alinea jornadas ligadas, sus incidencias, las FALTAS y las solicitudes. No modifica instantes.
- **"Hoy" del panel:** `GET /api/attendance/today` (día operativo calculado por el servidor). Jornadas, Incidencias e historial ya no usan la fecha del navegador. La prueba E2E (51) vuelve a su forma original: con D-78 el tablero "hoy" muestra el turno también entre las 00:00 y el corte.

## Decisiones técnicas de la Fase 4 (internas; respetan el contrato)

- **Valores de Fatboy por CLI, no por migración:** RN-ORG-09 prohíbe dejar un negocio fijo en código o migraciones. `platform set-policy --slug fatboy --param breakRequiredAfterMin=360 --param exitToleranceMin=5` crea el override de negocio (validado como cualquier override, auditado en la bitácora del negocio y en la de plataforma). El E2E y el runbook lo aplican igual.
- **Unicidad de FALTA (ajusta D-44):** antes "una FALTA por turno aunque se resolviera"; ahora "una FALTA **no anulada** por turno". La anulada se conserva (nunca se borra) y el nuevo dueño de un turno reasignado puede recibir la suya. Es el ajuste mínimo que exige D-66.
- **Anulación por cancelar/reasignar en un trigger; por reprogramar en el servicio:** cancelar o reasignar es un hecho de los datos (trigger `void_falta_on_shift_change`, auditado con actor SYSTEM y el usuario que hizo el cambio). "Ahora termina en el futuro" depende del reloj de la aplicación (que las pruebas inyectan), así que esa anulación la hace `SchedulingService.updateShift` en la misma transacción.
- **Carrera cancelación ↔ reconciliación:** la reconciliación toma `FOR SHARE` sobre el turno, revalida que siga oficial y del mismo dueño, e inserta la FALTA en un `SAVEPOINT`; la guarda `FALTA_NOT_APPLICABLE` en PostgreSQL es la última línea. Probado con una prueba de carrera real (falla si se quita el candado).
- **Aprobación con instantes absolutos:** la solicitud guarda el instante UTC calculado al crearla (con la zona de la sucursal y el pliegue DST) y lo que se capturó en local; al aprobar se aplica ese instante exacto, sin volver a convertir (una aprobación nunca "mueve" la hora por un cambio de horario o de zona).
- **Permiso para solicitar desde el panel:** `attendance.correction.request` se comprueba sin alcance de sucursal (es sobre la propia ficha, donde sea que ocurrió); quién DECIDE sí se limita a la sucursal donde ocurrió.
- **`ADD_BREAK`:** la pausa nueva toma `sequence = máx + 1` (no se renumeran las existentes, que pueden estar referenciadas en auditoría o solicitudes); copia minutos permitidos y tolerancia del snapshot de la jornada.
- **Límite de exportaciones contado con la bitácora:** `report.exported` en `audit.audit_log` es la fuente (no hay otra tabla ni memoria del proceso, funciona con varias réplicas). Verificación barata antes de consultar y verificación definitiva serializada por usuario (`pg_advisory_xact_lock`) en la misma transacción que registra la exportación: 12 exportaciones en paralelo ⇒ exactamente 10. Exceder 100 000 filas no genera archivo ni registro.
- **Lectura consistente de reportes:** `TenantDb.runReadOnly` (`REPEATABLE READ`, solo lectura): todas las secciones del reporte salen de la misma foto.
- **SSE:** una conexión `LISTEN` por proceso API (del pool de `app_user`, que no tiene `BYPASSRLS`: el aviso no da acceso a datos), `LISTEN` por negocio solo mientras hay suscriptores, reconexión con `resync`. El navegador usa la misma cookie de sesión (sin tokens en la URL ni en `localStorage`). Respaldo en el cliente: error, cierre o 60 s sin `ping` ⇒ polling cada 30 s y reintento con espera creciente (15 s → 5 min).
- **Pase del kiosco renovado:** cada llamada de "Mis registros" devuelve un pase nuevo de 120 s (mismo HMAC con clave derivada); la inactividad de 20 s en la pantalla manda sobre la vigencia del pase.
- **"Revocar ahora"** reutiliza la revocación de token existente (`kiosk.token_revoked`): la credencial se valida en cada petición, así que no hace falta un mecanismo nuevo.
- **Recargas traslapadas en pantallas en vivo:** con avisos SSE, polling y cambios de filtro pueden coincidir varias consultas; el tablero y la bandeja solo aplican la respuesta MÁS RECIENTE (una respuesta vieja nunca pisa una nueva) y la sucursal por defecto nunca reemplaza una elegida por el usuario.
- **`/auth/me` incluye `employeeId`** (la ficha ligada a la membresía activa) para mostrar "Mis jornadas"; la autorización real sigue en el servidor (`NO_EMPLOYEE_RECORD`).
- **Prueba E2E (51):** dependía de la hora de ejecución (entre las 00:00 y el corte, el turno de madrugada caía en otro día que el tablero). Lo resolvió D-78; la prueba volvió a su forma original.

## Decisiones técnicas de la Fase 3 (para revisión)

- **Activación del kiosco (D-56) — opción más segura que "guardar el token":** al activar, el servidor **rota** la credencial del dispositivo. El token que se pegó deja de servir de inmediato (es de **un solo uso**: una captura de pantalla del token no permite activar una segunda tablet) y la credencial nueva viaja solo en una cookie `HttpOnly`, `SameSite=Strict`, `Secure` en producción (`__Host-kiosk`), con renovación deslizante (365 días sin uso ⇒ hay que reactivar). La activación también acepta un **código de emparejamiento** (8 caracteres, más cómodo de teclear). Las peticiones del kiosco con cookie exigen la cabecera anti-CSRF; `Authorization: Bearer` sigue aceptándose para integraciones.
- **Pase corto tras el PIN (RN-PIN-10):** identificar el PIN devuelve un pase firmado (HMAC-SHA256 con una clave derivada del secreto del servidor) ligado a negocio + dispositivo + empleado, válido 120 s; la acción no vuelve a enviar el PIN. La pantalla regresa sola al PIN a los 20 s de inactividad.
- **Jornada marcada para corrección = estado `REVIEW`** (`OPEN` → `REVIEW` → `CLOSED`): sigue sin hora de salida, ya no acepta checadas del kiosco y **no impide una nueva Entrada** (RN-OPE-06). La unicidad de D-40 aplica a `OPEN`. También se detecta al identificarse el empleado (RN-OPE-05), así el kiosco nunca queda "atorado" aunque la reconciliación no haya corrido.
- **Desempate del matching:** si dos turnos oficiales de la sucursal están en ventana, gana el de inicio más cercano a la hora de la Entrada.
- **`ENTRADA_FALTANTE` (RN-EVT-11) se conserva como marca informativa** cuando la Entrada llega después del fin de un turno de esa sucursal y ese día (la jornada queda sin turno, como pide D-35).
- **Un turno con jornada real ya no se cancela ni cambia de empleado/sucursal** (trigger + FK compuesta). Corregir sus horas sigue siendo posible (D-32).
- **Una checada en otra sucursal sobre una jornada abierta** (D-40) se registra como evento en la sucursal física del kiosco; la jornada conserva la sucursal donde inició.
- **Antirrebote (RN-EVT-02, 60 s por defecto) se mantiene:** dos checadas del mismo empleado con menos de `debounce_sec` se rechazan con el tiempo de espera. Para pruebas manuales rápidas puede bajarse a 0 en Políticas.
- **Correcciones:** acciones cerradas `SET_CLOCK_IN`, `SET_CLOCK_OUT`, `SET_BREAK_START`, `SET_BREAK_END`, `LINK_SHIFT`, `UNLINK_SHIFT` y `CREATE_SESSION` (D-53), con validación de orden, sin horas futuras, sin cruzar otra jornada y con concurrencia optimista (`version` de la jornada; cada checada la incrementa). Cerrar por corrección una jornada con la pausa abierta exige corregir antes el regreso. `CREATE_SESSION` no fabrica eventos físicos. Recalculan el retardo y la comida excedida y resuelven (sin borrar) las incidencias que ya no aplican.
- **Incidencias:** `OPEN` → `RESOLVED` (`CORRECTED`, `JUSTIFIED`, `CONFIRMED`, `DISMISSED`) con motivo; una resuelta no se modifica (trigger). Una abierta por tipo y jornada; una sola `FALTA` por turno aunque se resuelva. Resolver la propia incidencia también está prohibido.
- **Reconciliación:** comando `node dist/src/cli/reconcile.js` (servicio `reconcile` del compose) con el rol `app_user` y cada negocio en su contexto; candado consultivo por negocio; opcionalmente dentro de la API con `RECONCILE_INTERVAL_SEC` (apagado por defecto).
- **Privilegios:** `app_user` sin `DELETE` en asistencia y con `UPDATE` solo en las columnas que cambian por reglas de dominio; eventos y correcciones solo-agregar; `platform_ops` solo lectura.
- **Tablero:** se actualiza consultando cada 30 s (el tiempo real por SSE sigue siendo la Fase 4).

### Ajustes a reglas anteriores (mínimos, por decisiones nuevas)

| Regla anterior | Decisión nueva | Ajuste aplicado |
|---|---|---|
| RN-OPE-04: jornada sin turno ⇒ primer corte que ocurra al menos `max_hours_unscheduled` (14 h) después de la Entrada | D-48: `max_open_session_minutes = 960` | El parámetro `max_hours_unscheduled` (sin uso hasta ahora) se **renombró** a `max_open_session_minutes` (960, rango 60–2880); los overrides existentes se convirtieron a minutos. |
| RN-OPE-06 / RN-INC-01: incidencia `SALIDA_FALTANTE` | D-47: `SALIDA_OLVIDADA` | Se usa `SALIDA_OLVIDADA`. Se agregan `TURNO_EN_OTRA_SUCURSAL` (D-36) y `JORNADA_ABIERTA_EXCEDIDA` (D-48). |
| RN-OPE-06 "no bloquea nuevas entradas" vs. D-40 "una jornada abierta" | — | Ver estado `REVIEW` arriba: no hay contradicción si "abierta" = jornada activa en el kiosco. |
| Modelo 1.2 §8: `attendance_records` con columnas calculadas guardadas, `punch_event_voids` | D-37 (sin derivados) y D-52 (overrides) | Tablas `work_sessions` (valores efectivos), `events` (físicos), `breaks`, `incidents`, `corrections`; las diferencias y duraciones se calculan (duración/exceso por pausa = columnas generadas). |
| RN-EVT-05: ventana hasta el fin del turno | D-35 | Igual; solo se agrega que el turno debe ser oficial y de la sucursal del kiosco. |

## Decisiones técnicas de la Fase 2 (para revisión)

- **Copiar semana / aplicar plantilla = copia PARCIAL segura**, no todo-o-nada: cada turno se valida y se inserta en su propio *savepoint*; lo que no puede crearse vuelve en `conflicts` con su código (traslape, empleado inactivo, sin asignación, hora inexistente por DST, ya copiado…). `dryRun` ejecuta exactamente lo mismo en una transacción que se revierte (vista previa). Es **idempotente** (un mismo turno de origen no se copia dos veces al mismo horario, garantizado por índice único) y solo escribe en semanas en `DRAFT`. Si la sucursal está desactivada o la semana destino publicada, la operación completa se rechaza con error claro.
- **"Turno en curso" = misma restricción que terminado** (D-32 pedía "modificación restringida"): permiso de historial + motivo.
- **Crear un turno en el pasado** también exige permiso de historial + motivo (para que no sea una puerta trasera de la corrección histórica).
- **Duración válida** como política heredable (`shift_min_minutes` 60, `shift_max_minutes` 960) en vez de constante (principio "cero reglas quemadas").
- **ENCARGADO** recibe por defecto `schedules.view` y `schedules.manage` (dentro de su alcance, revocable), coherente con D-30 y con la aprobación de la Fase 1 para empleados.
- **Guardar borrador:** cada alta/edición se guarda al momento en el horario `DRAFT`; no hay un botón "guardar" aparte. Publicar exige la versión del horario que se vio (si alguien agregó un turno después, hay que recargar).
- **Cambiar un turno de sucursal** lo mueve al horario de esa sucursal y semana (se crea en `DRAFT` si no existía).
- **Conflictos con turnos de otras sucursales:** al encargado se le informa el rango horario del turno en conflicto, pero no su sucursal si está fuera de su alcance.
- **Posible ajuste a una regla anterior:** RN-HOR-07 (v1.0) pedía motivo para todo cambio de un turno publicado; D-31 lo precisa (motivo solo para cancelar). Se aplicó D-31.

## Aclaraciones de la Fase 1 (sin reabrir reglas funcionales)

- **Sesión:** cookie `HttpOnly` + `SameSite=Lax` + expiración (12 h); en producción `Secure` y prefijo `__Host-`. Nunca `localStorage`. Se **rota** el identificador al iniciar sesión y al cambiar de negocio; logout la revoca en el servidor.
- **Identidad ≠ negocio activo:** `login → identidad → membresías → negocio activo (en la sesión, validado por el servidor) → TenantDb`. Una membresía inactiva o un negocio suspendido quitan el negocio activo de las sesiones vivas; una identidad deshabilitada invalida todas sus sesiones.
- **Invitaciones (D-11):** el admin invita un correo con rol y alcance; el token (256 bits, guardado hasheado, uso único, 72 h) se muestra una vez al admin. Identidad nueva: el invitado elige su contraseña. Identidad existente: prueba su contraseña ACTUAL y solo se agrega la membresía (nunca se cambia su contraseña).
- **ENCARGADO** incluye por defecto `employees.manage` y `employees.pin.manage`, siempre limitados a su alcance de sucursales (RN-COR/RN-ROL: "opcional por permiso" → cada negocio puede quitarlo).
- **Kioscos:** el dispositivo (activo/inactivo) y su token (generar/revocar/regenerar) son cosas separadas.

## Despliegue

- La validación real de Docker/Coolify (imágenes, red, HTTPS, cookies `Secure`, persistencia, reinicios) la hace el dueño en su servidor; no bloquea fases. El repositorio mantiene listos `Dockerfile`s, `docker-compose.yml`, variables y documentación (`04-operacion.md`).
- [x] Fase 3: GitHub Actions en verde con migración `0008`, pruebas de asistencia, E2E del kiosco y smoke del comando de reconciliación.
- [x] Fase 4: GitHub Actions en verde con migraciones `0009`–`0010`, pruebas de solicitudes, reportes, SSE y kioscos, y E2E 53–59 (run #17, commit `1f4813d`). Las ejecuciones #12–#15 fallaron solo por la prueba E2E (51), que dependía de la hora (corregida en #16).
- [x] Una ejecución **real** de GitHub Actions en verde sobre PostgreSQL real (typecheck, build, migraciones desde cero, `check:tenancy`, pruebas, E2E, smoke): **run #5, commit `cc1d7cb`**. Las ejecuciones #1–#4 fallaron y se corrigieron (contraseñas de roles compartidas por el clúster; carrera de navegación en el E2E).

## Ajustes por el congelamiento (respecto al borrador anterior)

- Se **eliminó** `retardo_cuenta_como_falta_min` (contradice D-4).
- `operational_cutoff` pasó de columna de sucursal a **parámetro de política heredable** (D-20).
- La política **de plataforma** (valores por defecto) vive en `platform.policy_defaults`; el nivel Negocio ya no necesita estar completo.
- `INACTIVE`/`ACTIVE`, `WORKING`/`ON_BREAK`/`REVIEW` y demás enums en inglés (D-16).

## Fuera de la Fase 0 (se aborda después)

Alta de usuarios/invitaciones por el administrador del negocio, recuperación de contraseña por correo, login HTTP, UI. Ver `03-arquitectura.md §10`.

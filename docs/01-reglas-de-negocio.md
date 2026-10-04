# 01 · Reglas de negocio — Reloj checador (plataforma multi-negocio)

> **Versión 1.5 — CONGELADA** (1.5 = D-78 un solo día operativo) (1.1 = D-21 protección del PIN; 1.2 = D-22…D-32 planificación de horarios y turnos; 1.3 = D-33…D-65 asistencia, jornadas, checadas, pausas y kiosco; 1.4 = D-66…D-77 cierre del ciclo: faltas anuladas, salida anticipada, sin comida, pausa omitida, solicitudes de corrección, reportes y exportación, tiempo real y control de kioscos — contrato en `05-fase-4-contrato.md`). Cambios posteriores requieren una decisión explícita y quedan anotados en `00-decisiones.md`.
> Fatboy es el **primer negocio (tenant)**; ninguna regla ni dato está diseñado específicamente para Fatboy.
> Los valores `default` son los del **nivel plataforma** y se pueden sobrescribir por negocio, sucursal o empleado según la jerarquía de configuración (§10).

## 1. Glosario

| Término | Significado |
|---|---|
| **Plataforma** | El sistema completo, que aloja a varios negocios. |
| **Negocio / Organización** (tenant) | Cliente independiente (ej. Fatboy, Pizzería X). Sus datos jamás se mezclan con los de otro negocio. En datos: `organization_id`. |
| **Sucursal** | Local físico de un negocio. |
| **Empleado** | Persona de un negocio que checa (ficha de empleado). Se identifica con PIN. No tiene usuario/contraseña. |
| **Usuario** | Identidad **global** de acceso al panel web (correo + contraseña). Pertenece a la plataforma. |
| **Membresía** | Relación de un usuario con un negocio (estado, roles, alcance, ficha de empleado opcional). |
| **Kiosco** | Tablet registrada, ligada a un negocio, una sucursal y un dispositivo. |
| **Turno programado** (`shift`) | Lo que *debería* trabajar un empleado: sucursal + inicio + fin. |
| **Jornada real** (`work_session`) | Lo que *realmente* ocurrió: Entrada → Salida efectivas, con o sin turno (D-37). Shift = lo que debía trabajar; WorkSession = lo que ocurrió. |
| **Pausa / comida** (`break`) | Registro independiente de una salida a comer y su regreso, dentro de una jornada. |
| **Checada** (`event`) | Evento físico del kiosco (`CLOCK_IN`, `BREAK_START`, `BREAK_END`, `CLOCK_OUT`). **Inmutable.** |
| **Corrección** | Acción de dominio que cambia el valor EFECTIVO de una jornada o pausa (o crea la jornada que sí ocurrió). Nunca edita el evento físico (D-52). |
| **Incidencia** | Anomalía que requiere atención o justificación. |
| **Fecha laboral** (`business_date`) | Fecha *local* en que **inicia** el turno. Un turno 7 PM → 3 AM del 15 pertenece al día 14. |
| **Hora de corte operativo** | Hora local que separa un día operativo del siguiente (ej. 05:00). Parámetro heredable. |
| **Día operativo** | Intervalo entre dos cortes consecutivos. |
| **Política efectiva** | Resultado de aplicar la jerarquía Plataforma → Negocio → Sucursal → Empleado. |

## 2. Principios (no negociables)

1. **La jornada manda, no el día calendario.**
2. **El servidor es la única fuente de hora confiable.**
3. **Las checadas son inmutables.** Se corrige agregando registros.
4. **Nada se borra físicamente:** se desactiva o se cancela.
5. **Cero reglas quemadas:** tolerancias, tiempos y umbrales viven en configuración jerárquica.
6. **Toda acción administrativa importante queda en auditoría** (quién, cuándo, negocio, sucursal, antes y después).
7. **El servidor valida todo.** La pantalla solo *muestra*; el backend *impone*.
8. **El aislamiento entre negocios se impone en backend y en base de datos.**
9. **El sistema nunca inventa datos** (p. ej. una hora de salida que nadie registró).
10. **Las reglas de integridad críticas viven también en PostgreSQL** (RLS, constraints, índices, triggers), no solo en el ORM ni en la aplicación.
11. **Tiempo:** en base de datos todo instante se guarda en UTC; la zona horaria del negocio/sucursal se usa solo para **interpretar** turnos, cortes, retardos, reportes y días operativos.
12. **Preparado para crecer:** nada de lo diseñado impide agregar después nómina, periodos de pago, modo offline, QR/cámara u otros módulos.

## 3. Negocios (multi-tenant)

- **RN-ORG-01** Jerarquía: **Plataforma → Negocio → Sucursales → Empleados**.
- **RN-ORG-02** Todo dato de un negocio lleva `organization_id` obligatorio (sucursales, empleados, asignaciones, membresías y roles, kioscos y tokens, PIN, políticas, turnos, jornadas, pausas, checadas, correcciones, incidencias, auditoría y reportes).
- **RN-ORG-03** **Ninguna entidad puede referenciar otra de un negocio distinto**; lo garantiza la base de datos (FKs compuestas).
- **RN-ORG-04** El negocio activo se deduce de la **sesión autenticada o del token del kiosco**, jamás de un parámetro del cliente. El frontend nunca decide libremente el `organization_id`.
- **RN-ORG-05** Aislamiento en tres capas: backend (autenticación/autorización), acceso a datos (contexto obligatorio) y **RLS de PostgreSQL con roles sin `BYPASSRLS`**.
- **RN-ORG-06** Un usuario es una identidad única que puede pertenecer a varios negocios, pero **opera en uno a la vez** (el de su sesión).
- **RN-ORG-07** Dentro de un negocio un usuario puede tener acceso a una, varias o todas las sucursales **sin duplicar su cuenta**.
- **RN-ORG-08** Estados del negocio: `ACTIVE` / `SUSPENDED`. Suspendido: nadie accede ni checa; no se pierde ningún dato.
- **RN-ORG-09** Cada negocio tiene su identidad visual (nombre, logo) y **zona horaria obligatoria**. Nada de "Fatboy" va fijo en el código.
- **RN-ORG-10** El alta de negocios y de su primer administrador se hace por **script interno** de plataforma. Fuera de alcance: facturación, suscripciones, planes, pagos y onboarding comercial.
- **RN-ORG-11** CI incluye **pruebas de aislamiento** de lectura y escritura entre negocios y una **verificación de catálogo**: toda tabla multi-tenant nueva sin protección **hace fallar CI**.

## 4. Zona horaria, sucursales y asignaciones

- **RN-SUC-01** La **zona horaria es obligatoria al crear cada negocio** (IANA, validada). Sin valor por defecto fijo. Fatboy: `America/Tijuana`.
- **RN-SUC-02** Cada sucursal **hereda** la zona del negocio y puede **sobrescribirla** si está en otra zona. Zona efectiva = `COALESCE(sucursal, negocio)`.
- **RN-SUC-03** La zona efectiva se usa para interpretar turnos, cortes operativos, retardos, reportes y días operativos. Los instantes siempre se guardan en UTC.
- **RN-SUC-04** Todo empleado tiene **exactamente una asignación PRIMARIA vigente**; cambiarla cierra la anterior y conserva el historial.
- **RN-SUC-05** Un empleado puede tener **asignaciones TEMPORALES** a otras sucursales **del mismo negocio** (rango de fechas y motivo).
- **RN-SUC-06** **Checar sin asignación en esa sucursal SE PERMITE** (mismo negocio) y se marca `SIN_ASIGNACION_SUCURSAL` para que el encargado/administrador regularice. El kiosco conoce su `organization_id` y `branch_id` por su token, así que **jamás puede cruzarse a otro negocio**.
- **RN-SUC-07** Programar un turno requiere asignación vigente en esa sucursal para esa fecha.
- **RN-SUC-08** Visibilidad: administrador = todas las sucursales de su negocio; encargado = las de su alcance (empleados con asignación vigente y jornadas ocurridas en ellas).
- **RN-SUC-09** Las jornadas guardan la sucursal **donde se trabajó**; los reportes por sucursal usan ese dato.

## 5. Día operativo y jornadas abiertas (olvido de salida)

- **RN-OPE-01** La **hora de corte operativo** es un parámetro de política (default 05:00) heredable Plataforma → Negocio → Sucursal. Un día operativo va de un corte al siguiente, en la zona efectiva de la sucursal.
- **RN-OPE-02** Para una checada **sin turno**, la fecha laboral es la del día operativo de la Entrada.
- **RN-OPE-03** **El sistema NUNCA inventa una hora de salida.**
- **RN-OPE-04** Una jornada abierta se marca como **salida olvidada** (`SALIDA_OLVIDADA`, D-47) al llegar el **primer corte operativo posterior al fin programado de su turno**. Sin turno: cuando lleva abierta `max_open_session_minutes` (960) ⇒ `JORNADA_ABIERTA_EXCEDIDA` (D-48). *(1.3: reemplaza el criterio de `max_hours_unscheduled`.)*
- **RN-OPE-05** Detección en dos momentos: proceso automático cada minuto y **al identificarse el empleado** si su jornada abierta ya terminó su turno y se abrió la ventana de otro turno suyo (así nunca queda "atorado").
- **RN-OPE-06** Al marcarla: estado `REVIEW`, salida vacía, duración **no calculada** ("incompleta"), incidencia `SALIDA_OLVIDADA`/`JORNADA_ABIERTA_EXCEDIDA` (y `REGRESO_COMIDA_FALTANTE` si tenía la pausa abierta) y **requiere corrección**. Ya no acepta checadas del kiosco y no bloquea nuevas entradas (la unicidad de D-40 aplica a jornadas `OPEN`).
- **RN-OPE-07** La corrección agrega la salida real que confirme el encargado, con motivo; la jornada se recalcula.

## 6. Identificación en el kiosco (PIN)

- **RN-PIN-01** **PIN de 6 dígitos generado por el sistema** (aleatorio criptográfico; se descartan PIN triviales como 000000 o 123456).
- **RN-PIN-02** Único entre **empleados activos del mismo negocio**; no global. **El mismo PIN puede existir en dos negocios**.
- **RN-PIN-03** **Nunca se guarda en texto plano**: solo un hash con secreto del servidor (`HMAC-SHA-256(pepper, organización ‖ PIN)`).
- **RN-PIN-04** **Solo se muestra una vez**, al generarlo o restablecerlo. No existe forma de consultarlo después.
- **RN-PIN-05** El empleado **no puede cambiarlo** en el MVP. Lo genera/restablece el administrador o el encargado con permiso.
- **RN-PIN-06** **Restablecer invalida inmediatamente el anterior.** La baja del empleado invalida el PIN.
- **RN-PIN-07** Auditoría del alta/restablecimiento (quién, cuándo, a quién), **sin registrar nunca el PIN** ni su hash.
- **RN-PIN-08** **Protección contra intentos masivos sin inutilizar el kiosco (D-21):** pausa POR DISPOSITIVO. Con `pin_max_attempts` (5) fallos consecutivos ⇒ pausa de `pin_lockout_sec` (10 s); cada fallo posterior duplica la pausa (20, 40, 80 s…) hasta el tope `pin_lockout_max_sec` (120 s; máximo configurable 300 s). **Nunca** se bloquea el kiosco por periodos largos. Un acierto reinicia el contador. Cada pausa se registra en auditoría como evento de seguridad. Todo intento se registra (sin el PIN). Mensaje de error genérico ("Código no válido").
- **RN-PIN-09** Un **kiosco** se empareja desde el panel con un código de un solo uso y de vencimiento corto. Su token pertenece obligatoriamente a **`organization_id + branch_id + device_id`**, es revocable y se guarda hasheado.
- **RN-PIN-10** Tras identificarse, la sesión del empleado es corta (default 20 s de inactividad) y se limita a ese empleado, kiosco y negocio. Tras una checada se muestra confirmación unos segundos y se regresa a la pantalla inicial.

## 7. Checadas, pausas y máquina de estados

| Estado de la jornada | Acciones disponibles |
|---|---|
| Sin jornada abierta | **Entrada** |
| `WORKING` | **Salida**, y **Salida a comer** si no se alcanzó `max_breaks` |
| `ON_BREAK` | **Regreso de comer** (solo esta) |

- **RN-EVT-01** El backend rechaza cualquier transición fuera de esa tabla, en **una transacción con bloqueo**.
- **RN-EVT-02** **Antirrebote:** checada del mismo empleado a menos de `debounce_sec` (60 s) de la anterior ⇒ rechazada.
- **RN-EVT-03** Las pausas son **registros independientes** (`attendance_break`), no columnas de la jornada. La política define `max_breaks` (default **1**) y `break_allowed_min` por pausa (default **35**). Se podrán configurar 2 o más pausas **sin cambiar el modelo**.
- **RN-EVT-04** Un empleado tiene **a lo más una jornada abierta** (garantizado por la BD).
- **RN-EVT-05** **Entrada ligada a turno:** se busca el turno del empleado en esa sucursal cuya ventana contenga la hora: desde `inicio − early_entry_window_min` (60 min, política configurable por negocio/sucursal) hasta el fin del turno. Se **guarda siempre la hora real**.
- **RN-EVT-06** **Sin turno programado: SE PERMITE** y queda marcada `SIN_TURNO_PROGRAMADO` para revisión. Aplica también si entra antes de la ventana y no hay otro turno que coincida.
- **RN-EVT-07** **Turnos nocturnos:** Salida y pausas se agregan a la **jornada abierta** aunque ya sea otro día calendario; la jornada conserva la fecha laboral de su Entrada.
- **RN-EVT-08** Estando `ON_BREAK` no se permite Salida: primero Regreso. Si olvidó el regreso, la pausa quedará excesiva y para corrección.
- **RN-EVT-09** Jornada abierta vencida: ver §5.
- **RN-EVT-10** El kiosco no permite modificar ni cancelar una checada hecha.
- **RN-EVT-11** **Olvido de Entrada:** si la "Entrada" cae después del fin de su turno se registra y se marca `ENTRADA_FALTANTE`; se resuelve con una corrección.
- **RN-EVT-12** **Preparado para modo offline (sin implementarlo aún).** Toda checada guarda: `client_event_id` (idempotencia), `device_id`, `occurred_at` (cuándo ocurrió), `received_at` (cuándo la recibió el servidor), `source` (origen: `KIOSK_ONLINE`, `KIOSK_OFFLINE_SYNC`, `CORRECTION`) y `time_source` (`SERVER`/`DEVICE`). La unicidad `(organización, dispositivo, client_event_id)` impide duplicados al reenviar. Online: `occurred_at = received_at` (hora del servidor).
- **RN-EVT-13** **MVP sin internet:** el kiosco muestra claramente **"Sin conexión"** y no registra. La contingencia es **corrección manual con motivo**. El modo offline real (guardar local y sincronizar) es una fase posterior; sus eventos se marcarían para revisión.

## 8. Horarios y turnos (D-22 … D-32)

Modelo: **Plantilla → Horario semanal → Turno concreto → (Fase 3) Jornada real.** La asistencia se compara SIEMPRE contra el turno concreto, nunca contra la plantilla.

- **RN-HOR-01** **Turno concreto** = empleado + sucursal + fecha laboral + instantes reales (`starts_at`/`ends_at` en UTC) + `timezone_snapshot`. Es la **fuente de verdad** para asistencia (D-22). La API trabaja con fecha/hora local y la convierte con la zona efectiva de la sucursal (D-26).
- **RN-HOR-02** Duración válida configurable: `shift_min_minutes` (60) y `shift_max_minutes` (960), heredables negocio → sucursal. La duración programada se calcula de los instantes (columna generada) y **no descuenta comida**.
- **RN-HOR-03** **Sin traslapes** del mismo empleado entre turnos no cancelados, **aunque sean de sucursales distintas**; intervalos `[inicio, fin)` (07–15 y 15–23 no se traslapan). Restricción de exclusión en PostgreSQL (D-29).
- **RN-HOR-04** **Horario semanal** por sucursal y semana (`week_start_day`): `DRAFT` → `PUBLISHED`. Publicar es una acción **explícita e irreversible** (D-24). En `DRAFT` se edita libremente según permisos y un turno se puede quitar; un turno de un horario publicado **nunca se borra**: se cancela.
- **RN-HOR-05** **Plantillas** separadas de los turnos (D-23): ayudan a generar semanas; modificarlas **nunca** cambia turnos existentes, históricos ni publicados. **Copiar semana anterior** conserva las **horas locales** (no suma 7×24 h en UTC), valida empleados activos, sucursal activa, asignaciones, traslapes y permisos, y reporta cada turno que no pudo copiarse con su motivo.
- **RN-HOR-06** Día sin turno = descanso, no genera falta.
- **RN-HOR-07** Un turno publicado se puede editar, reasignar, cambiar de sucursal u horario y cancelar; **todo cambio se audita** con antes/después (D-31). **Motivo obligatorio para cancelar**; la edición normal no lo exige. *(Precisa la versión anterior de esta regla, que pedía motivo para todo cambio.)* **D-33:** un turno de un horario publicado solo se mueve a una sucursal/semana cuyo horario ya esté publicado; nunca termina en un borrador.
- **RN-HOR-08** Programan el administrador (todo el negocio) y el ENCARGADO **solo en las sucursales de su alcance**, **solo con empleados asignados a esa sucursal en esa fecha** (D-30). `schedules.manage` viene por defecto en ENCARGADO y es revocable por negocio. La excepción operativa del kiosco (D-17, `SIN_ASIGNACION_SUCURSAL`) **no aplica** a la planificación.
- **RN-HOR-09** **Turnos nocturnos** (D-27): un solo turno (19:00 → 03:00 del día siguiente), `ends_at > starts_at` siempre; pertenecen al día en que **inician**.
- **RN-HOR-10** **DST** (D-28): solo zonas IANA. Una hora local **inexistente** se rechaza con error explícito; una hora **ambigua** exige indicar cuál (`EARLIER`/`LATER`). Nunca se guarda otra hora en silencio.
- **RN-HOR-11** **Zona del turno** (D-26): se guarda `timezone_snapshot`; cambiar después la zona de la sucursal no reinterpreta turnos existentes.
- **RN-HOR-12** **Turnos históricos** (D-32): un turno **futuro** se edita normalmente. Uno **en curso** o **terminado** (y crear un turno en el pasado) exige el permiso `schedules.history.manage` (solo ADMIN por defecto) **y motivo**; queda auditado como corrección histórica. Corrección de planificación ≠ corrección de asistencia.
- **RN-HOR-13** **Estados del turno** (D-25): solo `SCHEDULED` / `CANCELLED`. Retardo, falta, trabajando, etc. pertenecen a la asistencia.
- **RN-HOR-14** **Concurrencia:** cada cambio envía la versión que el usuario vio; si otra persona modificó antes el turno, el horario o la plantilla, se rechaza y hay que recargar (nada se sobrescribe en silencio).

## 8 bis. Asistencia: jornadas, checadas, pausas y kiosco (D-33 … D-65)

- **RN-ASI-01** **Turno oficial** = `SCHEDULED` de un horario `PUBLISHED` (D-34). Un turno en borrador o cancelado no existe para la asistencia: no se muestra al empleado, no se liga y no genera retardo, ausencia ni falta (D-62, D-63). Un turno publicado nunca vuelve implícitamente a borrador (D-33).
- **RN-ASI-02** **Matching de la Entrada** (D-35): turno oficial del mismo empleado y de la **sucursal del kiosco** cuya ventana `[inicio − early_entry_window_min, fin)` contiene la hora del servidor; si hay varios, el de inicio más cercano. Fuera de ventana ⇒ jornada sin turno (`SIN_TURNO_PROGRAMADO`; `ENTRADA_FALTANTE` si su turno de ese día ya terminó).
- **RN-ASI-03** **Otra sucursal** (D-36): la jornada pertenece a donde ocurrió; nunca se liga a un turno de otra sucursal; marcas `SIN_ASIGNACION_SUCURSAL` y `TURNO_EN_OTRA_SUCURSAL`. No se bloquea.
- **RN-ASI-04** **Jornada real** (D-37): `OPEN` → `CLOSED`, o `OPEN` → `REVIEW` (requiere corrección) → `CLOSED`. Guarda los instantes efectivos; las diferencias y duraciones se calculan. Nunca modifica el turno.
- **RN-ASI-05** **Eventos físicos** inmutables e idempotentes por `device_id + client_event_id` (D-38, D-54): un reintento devuelve el mismo resultado.
- **RN-ASI-06** **Acciones del kiosco** (D-39): sin jornada ⇒ Entrada; abierta ⇒ Salida a comer (si no se alcanzó `max_breaks`) y Salida; en pausa ⇒ solo Regreso de comer. Salida con pausa abierta se rechaza: primero el regreso (D-50).
- **RN-ASI-07** **Una jornada abierta por empleado** en el negocio (D-40), garantizado por PostgreSQL; en otra sucursal el kiosco reconoce la abierta. Dos Entradas simultáneas crean una sola jornada (D-55).
- **RN-ASI-08** **Retardo real** (D-41, D-42): diferencia completa con signo contra `starts_at` (06:40 ⇒ −20; 07:08 ⇒ +8 sin incidencia con tolerancia 10; 07:12 ⇒ +12 y `RETARDO`). Se guarda la hora real, sin redondear.
- **RN-ASI-09** **Estados derivados** (D-43): 07:00–07:10 en tolerancia · 07:11–07:59 retardo/aún no llega · desde 08:00 ausente/no ha llegado (no definitivo) · con Entrada: trabajando con su retardo real · falta solo si el turno termina sin Entrada.
- **RN-ASI-10** **Reconciliación** (D-44, D-47, D-48, D-50): proceso periódico e idempotente que materializa `FALTA` (una por turno), `SALIDA_OLVIDADA`, `JORNADA_ABIERTA_EXCEDIDA` y `REGRESO_COMIDA_FALTANTE`. Nunca inventa horas.
- **RN-ASI-11** **Día operativo** (D-46, D-78): mientras no llega la hora de corte de la sucursal (política `operational_cutoff`, en su zona IANA; Fatboy 05:00, D-45), todo pertenece al día operativo **anterior**. El turno pertenece al día operativo de su **inicio**; una jornada con turno, al del turno; una jornada sin turno, al de su Entrada. Ej. con corte 05:00: 02-oct 23:30 ⇒ 02-oct · 03-oct 01:30 ⇒ 02-oct · 03-oct 04:59:59 ⇒ 02-oct · 03-oct 05:00:00 ⇒ 03-oct.
- **RN-ASI-20** **Una sola fecha para agrupar** (D-78): tablero, jornadas, incidencias (incluida la FALTA), reconciliación, solicitudes, correcciones, reportes, exportaciones y todo filtro "hoy" usan ese mismo día operativo. Los instantes reales nunca cambian. La fecha de planeación del turno (`business_date`, columna del horario semanal) no se usa para asistencia. Un turno con jornada real no cambia de día operativo; cambiar la hora de corte o la zona recalcula solo los turnos que aún no empiezan.
- **RN-ASI-12** **Kiosco** (D-56 … D-59): credencial propia del dispositivo (cookie `HttpOnly`, activación con token de un solo uso o código de emparejamiento); PIN enmascarado que nunca aparece en logs, errores, auditoría ni URLs; al empleado solo su nombre, sucursal, turno oficial actual/próximo, acciones y confirmación; regreso automático a la pantalla de PIN.
- **RN-ASI-13** **Duración y salida** (D-64, D-65): duración real = salida efectiva − entrada efectiva; pausas aparte, sin descuento automático; diferencia de salida con signo, sin sanciones.

## 8 ter. Cierre del ciclo de asistencia (D-66 … D-77, Fase 4)

- **RN-ASI-14** **FALTA anulada por el plan** (D-66): si el turno de una FALTA abierta se **cancela**, se **reasigna** (a otra persona o sucursal) o se **reprograma** y ahora termina en el futuro, la FALTA pasa a `RESUELTA` con resolución `ANULADA` (`VOIDED`), origen **Sistema** y motivo `SHIFT_CANCELLED: <motivo>`, `SHIFT_REASSIGNED` o `SHIFT_RESCHEDULED`; se audita. **Nunca se borra.** Un turno no oficial no puede recibir FALTA (lo impide PostgreSQL); el nuevo dueño de un turno reasignado sí puede recibir la suya.
- **RN-ASI-15** **Salida anticipada** (D-67): al cerrar (o corregir) una jornada **con turno**, si la salida efectiva es más de `exit_tolerance_min` minutos antes del fin del turno ⇒ `SALIDA_ANTICIPADA` con los minutos reales. No aplica sin turno, sin salida ni a la salida tarde. Fatboy: tolerancia 5.
- **RN-ASI-16** **Sin comida** (D-68): con `require_break = sí`, una jornada cerrada sin ninguna pausa cerrada y con duración real ≥ `break_required_after_min` ⇒ `SIN_COMIDA` (control, no descuenta horas). Fatboy: 360 (6 h). Default de plataforma 0.
- **RN-ASI-17** **Pausa omitida** (D-69): se registra por corrección `ADD_BREAK` (inicio, fin y motivo), dentro de la jornada, sin cruzarse con otras pausas, sin horas futuras; **no** crea evento físico; recalcula exceso de comida y `SIN_COMIDA`; puede exceder `max_breaks` (queda auditado).
- **RN-ASI-18** **Jornada creada por corrección** (D-72): sin turno genera `SIN_TURNO_PROGRAMADO` (y `SIN_ASIGNACION_SUCURSAL` si aplica); ligada a un turno oficial **no**, y resuelve como `CORREGIDA` la FALTA de ese turno.
- **RN-ASI-19** **Snapshot de políticas**: cada jornada congela al abrirse las tolerancias de entrada y salida, la pausa obligatoria, `break_required_after_min`, los minutos permitidos y la tolerancia de pausa; los recálculos usan siempre el snapshot (las jornadas anteriores a la Fase 4 usan la política actual solo para los valores que no congelaron).

**Solicitudes de corrección (D-70, D-71)**

- **RN-SOL-01** El empleado **solicita**; nunca modifica. Canales: **kiosco** (cualquier empleado, identificado por PIN, en "Mis registros") y **panel** ("Mis jornadas", solo para cuentas ligadas a una ficha de empleado). No hay cuenta web para todos los empleados.
- **RN-SOL-02** Acciones: hora de Entrada, hora de Salida, inicio o regreso de una pausa, pausa omitida y jornada no registrada (con turno, p. ej. una FALTA; o sin turno). Siempre con motivo.
- **RN-SOL-03** **Ventana** por **día operativo** (zona y hora de corte de la sucursal): `0 ≤ hoy operativo − día operativo del registro ≤ correction_request_window_days` (7). **Máximo** `max_pending_correction_requests` (3) pendientes por empleado. Una sola solicitud pendiente igual por objetivo (lo garantiza PostgreSQL). Idempotente por identificador del cliente.
- **RN-SOL-04** Estados: `PENDIENTE` → `APROBADA` | `RECHAZADA` | `CANCELADA` (terminales, inmutables). Cancelar: solo el solicitante y solo pendiente. Rechazar: motivo obligatorio.
- **RN-SOL-05** **Aprobar aplica EXACTAMENTE lo solicitado**, con la misma lógica, validaciones y auditoría que una corrección directa y en la misma transacción; la corrección queda ligada a la solicitud. **No existe "aprobar con ajuste"** ni edición por el aprobador: si se requieren otros valores, se rechaza y se aplica una corrección directa. Si la corrección ya no es válida (p. ej. el turno se canceló o la jornada cambió), la aprobación falla y la solicitud sigue pendiente.
- **RN-SOL-06** Decide quien tiene `attendance.correction.apply` en la **sucursal donde ocurrió**. **Nadie decide su propia solicitud** (ni como empleado ni como quien la registró); lo impide también PostgreSQL. El ENCARGADO tiene `attendance.correction.request` por defecto (revocable).

**Kioscos (D-76)**

- **RN-KIO-01** Estado derivado: **Sin credencial** · **Pendiente de activar** · **Activo** · **Inactivo**; se muestran fecha de activación, último uso y última IP (último uso se registra a lo más una vez por minuto).
- **RN-KIO-02** **Revocar ahora** invalida la credencial del dispositivo: el navegador queda fuera en su **siguiente petición**, aunque conserve su cookie (el servidor valida en cada llamada). La cookie puede durar hasta un año (se renueva con el uso), pero el control siempre es del servidor.
- **RN-KIO-03** "Mis registros" en el kiosco: pase temporal renovado en cada acción, solo la propia ficha y solo la ventana de solicitud, datos mínimos; 20 s de inactividad, "Terminar" o un pase vencido borran todo el estado del empleado en la pantalla, sin forma de volver a verlo.

## 9. Cálculo de asistencia

Variables: `Hp_ini`/`Hp_fin` programados; `Hr_ini`/`Hr_fin` = primera Entrada / última Salida reales. Los segundos se truncan antes de comparar.

| Resultado | Regla |
|---|---|
| **Diferencia de entrada** | `Hr_ini − Hp_ini` en minutos (negativa = antes). **Siempre se guarda.** |
| **A tiempo** | `Diferencia ≤ entry_tolerance_min` (default 10). Sin incidencia. |
| **Retardo** | `Diferencia > entry_tolerance_min`. Genera incidencia y **registra los minutos reales completos**. |
| **Falta** | El turno terminó y **nunca hubo Entrada**. La registra el sistema al cierre. |
| **Salida anticipada** | `Hr_fin < Hp_fin − exit_tolerance_min`, solo si existe la Salida. |
| **Horas programadas** | `Hp_fin − Hp_ini` |
| **Horas trabajadas** | `Hr_fin − Hr_ini`. **No se descuenta ninguna pausa.** Vacío si la jornada está incompleta. |
| **Duración de cada pausa** | `Regreso − Salida a comer` |
| **Exceso de cada pausa** | `max(0, duración − break_allowed_min − break_tolerance_min)` |
| **Acumulados de la jornada** | Suma de duraciones de pausas y suma de excesos |

> Ejemplo (tolerancia 10): turno 7:00 → entra 7:08 ⇒ a tiempo (diferencia 8 guardada, sin incidencia). Entra 7:12 ⇒ retardo de 12 min reales, con incidencia.

- **RN-CAL-01** **Un retardo, por grande que sea, nunca se convierte en falta si existe una Entrada real.** Conserva siempre el retardo real completo.
- **RN-CAL-02** **Las pausas son solo control de tiempo e incidencias.** No descuentan horas, no calculan pagos, no afectan nómina ni tienen relación con el costo de alimentos. Ej.: 35 permitidos y 42 de duración ⇒ duración 42, exceso 7, incidencia `COMIDA_EXCEDIDA`.
- **RN-CAL-03** Pausa con salida pero sin regreso ⇒ incidencia `REGRESO_COMIDA_FALTANTE`.
- **RN-CAL-04** `require_break` (default no) ⇒ incidencia `SIN_COMIDA` si la jornada no tuvo pausa.
- **RN-CAL-05** Los resultados se guardan con una **copia de la política efectiva usada**. Cambiar una configuración hoy no modifica silenciosamente el pasado; solo se recalcula con corrección o reproceso explícito (auditado).
- **RN-CAL-06** Los cálculos viven en una **función pura** con pruebas (nocturnos, zonas horarias, cortes).
- **RN-CAL-07** Nada de lo anterior afecta nómina ni horas pagadas automáticamente. El modelo no impide agregar después nómina y periodos de pago.

## 10. Configuración: jerarquía de políticas (D-20)

- **RN-CFG-01** Herencia: **Plataforma → Negocio → Sucursal → Empleado**. Un nivel más específico sobrescribe al anterior.
- **RN-CFG-02** **Solo se guardan overrides** (valores explícitos). La política efectiva se calcula; **no se duplican configuraciones completas**. El nivel Plataforma es el único siempre completo (valores por defecto del sistema).
- **RN-CFG-03** Cada parámetro declara hasta qué nivel puede sobrescribirse:

| Parámetro | Default plataforma | Niveles permitidos |
|---|---|---|
| `entry_tolerance_min` | 10 | negocio · sucursal · empleado |
| `exit_tolerance_min` | 0 (Fatboy 5) | negocio · sucursal · empleado |
| `max_breaks` | 1 | negocio · sucursal · empleado |
| `break_allowed_min` (por pausa) | 35 | negocio · sucursal · empleado |
| `break_tolerance_min` | 0 | negocio · sucursal · empleado |
| `require_break` | no | negocio · sucursal · empleado |
| `break_required_after_min` (D-68) | 0 (Fatboy 360) | negocio · sucursal · empleado |
| `correction_request_window_days` (D-70) | 7 | negocio · sucursal |
| `max_pending_correction_requests` (D-70) | 3 | negocio |
| `early_entry_window_min` | 60 | negocio · sucursal |
| `absent_after_min` (estado "Ausente") | 60 | negocio · sucursal |
| `operational_cutoff` (hora) | 05:00 | negocio · sucursal |
| `max_open_session_minutes` (D-48) | 960 | negocio · sucursal |
| `debounce_sec` | 60 | negocio · sucursal |
| `pin_max_attempts` | 5 | negocio · sucursal |
| `pin_lockout_sec` (pausa inicial) | 10 | negocio · sucursal |
| `pin_lockout_max_sec` (tope de pausa) | 120 (máx. 300) | negocio · sucursal |
| `week_start_day` (1 = lunes) | 1 | negocio |
| `shift_min_minutes` / `shift_max_minutes` | 60 / 960 | negocio · sucursal |

La zona horaria **no es una política**: es un atributo del negocio (obligatorio) y de la sucursal (opcional).

- **RN-CFG-04** Ejemplo: Fatboy `break_allowed_min` = 35; San Marcos hereda 35; Venecia define 40; el empleado X en Venecia define 30 ⇒ efectivo para X = **30**; para otro empleado de Venecia = 40; en San Marcos = 35.
- **RN-CFG-05** Ningún negocio lee ni modifica la configuración de otro. Los cambios se auditan y aplican hacia adelante (RN-CAL-05).
- **RN-CFG-06** Los valores se validan en la aplicación **y** con restricciones en la base de datos (rangos y niveles permitidos).

## 11. Incidencias y estados de llegada

- **RN-INC-01** Tipos implementados (1.4): `RETARDO`, `FALTA`, `SIN_TURNO_PROGRAMADO`, `SIN_ASIGNACION_SUCURSAL`, `TURNO_EN_OTRA_SUCURSAL` (informativa, D-36), `ENTRADA_FALTANTE` (Entrada después del fin de su turno), `SALIDA_OLVIDADA` (D-47), `JORNADA_ABIERTA_EXCEDIDA` (D-48), `REGRESO_COMIDA_FALTANTE`, `COMIDA_EXCEDIDA`, `SALIDA_ANTICIPADA` (D-67) y `SIN_COMIDA` (D-68).
- **RN-INC-02** Las genera el **sistema**; el empleado nunca las crea ni edita.
- **RN-INC-03** `ABIERTA` → `RESUELTA` con resolución `CORREGIDA` (por una corrección), `JUSTIFICADA`, `CONFIRMADA`, `DESCARTADA` o `ANULADA` (solo el sistema, D-66), siempre con motivo, origen (persona, corrección o sistema), usuario y fecha. Una incidencia resuelta no se modifica ni se borra; nadie resuelve las propias.
- **RN-INC-04** Los reportes distinguen confirmados de justificados. Las anuladas por el sistema no cuentan en totales, pero siguen visibles en el historial y en el reporte de incidencias.
- **RN-INC-05** El empleado puede consultar (solo lectura) sus registros recientes en el kiosco ("Mis registros", RN-KIO-03).
- **RN-INC-06** **Estados de llegada (separados):**

| Estado | Cuándo |
|---|---|
| **A tiempo** | Entrada dentro de la tolerancia |
| **Retardo / Aún no llega** | Pasó la tolerancia y no hay Entrada (o, con Entrada, llegó tarde) |
| **Ausente / No ha llegado** | Pasaron `absent_after_min` (60) sin Entrada. **No es definitivo**: todavía puede llegar |
| **Trabajando** | Ya checó Entrada (conserva el retardo real completo si lo hubo) |
| **Falta** | **Solo** cuando el turno terminó y nunca hubo Entrada |

## 12. Correcciones

- **RN-COR-01** El empleado no puede corregir nada; puede **solicitar** una corrección (RN-SOL-01).
- **RN-COR-02** Una corrección es una **acción de dominio**: hora de Entrada, de Salida, inicio o fin de una pausa, ligar/desligar el turno oficial, agregar una pausa omitida (D-69) o crear la jornada que sí ocurrió (D-53). Cambia el valor **efectivo**; el evento físico no se toca (D-52). **Motivo obligatorio siempre.**
- **RN-COR-03** **Siempre se conserva la original** (nunca se borra ni reemplaza en silencio) y hay **auditoría antes/después**.
- **RN-COR-04** **Encargado:** corrige jornadas **ocurridas en sus sucursales**, sin importar la sucursal habitual del empleado.
- **RN-COR-05** **Nadie puede corregir su propia jornada.** La de un encargado la corrige otro encargado con permiso sobre esa sucursal o un administrador.
- **RN-COR-06** **Administrador:** puede corregir empleados y encargados **dentro de su negocio** (nunca de otro), excepto su propia jornada.
- **RN-COR-07** `attendance.correction.request` habilita solicitar correcciones de la **propia** ficha desde el panel (D-70); la aprobación genera la corrección (RN-SOL-05).
- **RN-COR-08** Al aplicarse se recalcula la jornada y la incidencia pasa a `CORREGIDA`. No puede quedar una secuencia ilógica.

## 13. Empleados

- **RN-EMP-01** Nunca se borra un empleado: `ACTIVE` / `INACTIVE` con fecha y motivo de baja.
- **RN-EMP-02** Baja: se invalida el PIN, se cancelan turnos futuros (auditado), historial intacto.
- **RN-EMP-03** Reingreso: se reactiva el registro con nuevo PIN y nueva asignación primaria.
- **RN-EMP-04** Número de empleado único **dentro del negocio**.
- **RN-EMP-05** **Cuenta de panel y ficha de empleado son conceptos separados.** La membresía puede ligar opcionalmente a una ficha: alguien puede ser solo empleado, empleado + encargado, empleado + administrador, o administrador/dueño sin checar.

## 14. Identidad, acceso y roles

- **RN-IDN-01** La **identidad y credenciales pertenecen a la plataforma** (usuario global).
- **RN-IDN-02** El administrador de un negocio **puede activar, desactivar o quitar la membresía** de su negocio. **No puede ver la contraseña ni cambiar directamente la contraseña global** (la misma cuenta puede pertenecer a otros negocios). Solo ve a los usuarios que son miembros de su negocio.
- **RN-IDN-03** Mientras no exista recuperación automática, el **restablecimiento global lo realiza la plataforma**; además, **cada persona puede cambiar su propia contraseña** desde "Mi cuenta" probando la actual (D-80): se cierran sus demás sesiones y se audita sin la contraseña. La **recuperación por correo** queda preparada para una fase posterior.
- **RN-IDN-04** Login: correo + contraseña. Si el usuario pertenece a un negocio entra directo; si pertenece a varios, **elige negocio**. El negocio queda fijado en la sesión.
- **RN-IDN-05** Cada negocio debe tener siempre al menos un administrador activo.
- **RN-IDN-06** Cambios de rol, permiso, alcance o membresía se auditan.
- **RN-IDN-07** **Alta de usuarios por invitación:** el administrador invita un correo con rol y alcance; el sistema genera un enlace de un solo uso (token aleatorio, guardado hasheado, con vencimiento, nunca en logs) que se muestra una vez al administrador. Si el correo ya es una identidad global, no se crea otra: el invitado prueba su contraseña actual y solo se agrega la membresía. El administrador nunca fija ni modifica la contraseña global.
- **RN-IDN-08** **Sesión:** cookie `HttpOnly`, `SameSite`, con expiración; `Secure` en producción. Nunca tokens en `localStorage`. El identificador de sesión rota al iniciar sesión y al cambiar de negocio. Al cambiar de negocio se revalida la membresía y no se conserva ningún permiso ni dato del negocio anterior.
- **RN-IDN-09** Membresía desactivada ⇒ pierde el acceso solo a ese negocio (también en sesiones abiertas). Identidad deshabilitada ⇒ pierde todo acceso. Negocio suspendido ⇒ nadie opera en él.

Modelo de permisos: **roles con permisos granulares** y **alcance** por asignación (todas las sucursales o lista).

| Rol | Alcance típico |
|---|---|
| **Administrador / Dueño del negocio** | Todas las sucursales de su negocio |
| **Encargado de sucursal** | Solo las sucursales asignadas (una o varias, con una cuenta) |
| **Empleado** | Sin cuenta web; kiosco con PIN |
| *Administrador de plataforma* | Fuera del producto por ahora: script interno |

| Capacidad | Empleado | Encargado | Administrador |
|---|:-:|:-:|:-:|
| Checar | ✅ | ✅ (si tiene ficha) | ✅ (si tiene ficha) |
| Ver sus asistencias, horarios, incidencias (kiosco) | ✅ | ✅ | ✅ |
| Ver empleados / asistencia / tablero de su alcance | — | ✅ | ✅ |
| Resolver incidencias | — | ✅ | ✅ |
| Aplicar correcciones (no las propias) | — | ✅ su alcance | ✅ |
| Solicitar corrección de lo propio | ✅ kiosco | ✅ kiosco / panel | ✅ kiosco / panel (si tiene ficha) |
| Aprobar o rechazar solicitudes (no las propias) | — | ✅ su alcance | ✅ |
| Programar horarios | — | con permiso | ✅ |
| Altas, bajas, PIN, asignaciones | — | opcional por permiso | ✅ |
| Sucursales, kioscos, configuración, roles, membresías | — | — | ✅ |
| Reportes y exportación | — | su alcance | ✅ |
| Auditoría | — | — | ✅ |

- **RN-ROL-01** El empleado no tiene cuenta web (acceso desde celular: mejora futura). Consulta y solicita desde el kiosco con su PIN; si además tiene una cuenta de panel ligada a su ficha, también desde "Mis jornadas" (D-70).
- **RN-ROL-02** Roles y permisos son **por negocio**.
- **RN-ROL-03** Un encargado nunca ve datos fuera de su alcance, aunque conozca identificadores.

## 15. Tablero en tiempo real

Muestra los estados de §11 (RN-INC-06) más: **En comida** (minutos transcurridos; rojo si excede), **Salió** y **Revisión**.

- **RN-RT-01** Incluye turnos nocturnos que iniciaron "ayer" y siguen abiertos. "Hoy" = **día operativo** de la sucursal (D-78): a las 02:00 del día 3 el tablero muestra el día 2, incluidos los turnos que empiezan antes del corte.
- **RN-RT-02** Actualización ≤ 2 s tras una checada; estados dependientes del tiempo cada ~30 s.
- **RN-RT-03** Cada usuario recibe solo su negocio y las sucursales de su alcance.
- **RN-RT-04** Tiempo real por **SSE** (D-75) en el tablero y en la bandeja de solicitudes: los avisos solo **invalidan** (tipo, id, sucursal, operación; sin datos personales) y la pantalla vuelve a consultar con sus permisos. Un aviso perdido nunca afecta la consistencia.
- **RN-RT-05** Si el canal en vivo no está disponible (proxy, red, límite de conexiones), la pantalla funciona igual por **polling cada 30 s** e indica el modo; se reintenta el canal con espera creciente.
- **RN-RT-06** La conexión revalida sesión, negocio y permisos periódicamente y se cierra al perderlos; máximo 5 conexiones por usuario y 30 min por conexión (el navegador reconecta solo).

## 16. Reportes y exportación

- **RN-REP-01** Filtros: empleado, sucursal y rango. Por **día operativo** (D-78), solo dentro del negocio y alcance.
- **RN-REP-02** **Accesos rápidos:** Hoy · Ayer · Esta semana · Semana pasada · 1–15 · 16–fin de mes · Este mes · Mes pasado · Rango personalizado. Se calculan en la zona de la sucursal; "Hoy/Ayer" usan el día operativo; "Semana" usa `week_start_day`.
- **RN-REP-03** Métricas: horas programadas, horas trabajadas, retardos (y minutos), faltas, pausas (duración y exceso por pausa y acumulado), salidas anticipadas, incidencias y correcciones.
- **RN-REP-04** Jornadas corregidas visibles con acceso al antes/después.
- **RN-REP-05** Exportación a **Excel (XLSX)** y **CSV** (D-74); **PDF** después; se audita.
- **RN-REP-06** **No existe entidad "periodo de pago"** por ahora; el diseño no impide agregarla (junto con nómina) más adelante.
- **RN-REP-07** Reportes (D-73): **resumen por empleado**, **detalle de jornadas** (incluye faltas reales), **incidencias** (todas, con resolución y origen) y **correcciones y solicitudes**. Siempre con valores **efectivos** y por **día operativo**.
- **RN-REP-08** Alcance: la **sucursal donde ocurrió** cada registro y donde el usuario tiene `reports.view`; exportar además exige `reports.export`. Nunca datos de otro negocio.
- **RN-REP-09** Quincenas: 1–15 y 16–fin de mes (actual y anterior). Los periodos rápidos los calcula el servidor; "Hoy" es el día operativo de la sucursal (o del negocio si son todas).
- **RN-REP-10** Límites (decisión 7): rango máximo **366 días**; exportación máxima **100 000 filas**; **10 exportaciones por minuto por usuario**.
- **RN-REP-11** XLSX con hoja del reporte y hoja **"Parámetros"** (negocio, sucursal, empleado, rango, zona, filas, quién y cuándo); CSV UTF-8 con BOM (RFC 4180). Los textos que parecen fórmulas (`=`, `+`, `-`, `@`) se neutralizan. Los archivos se generan al momento y no se guardan.
- **RN-REP-12** Cada exportación se audita con el reporte, formato, filtros y número de filas.

## 17. Auditoría

- **RN-AUD-01** Se audita como mínimo: empleados, asignaciones, PIN (alta/restablecimiento, sin el PIN), turnos, correcciones, incidencias, roles/permisos/alcances, membresías, políticas, kioscos, reprocesos, exportaciones.
- **RN-AUD-02** Cada registro: **negocio**, **sucursal (si aplica)**, quién (usuario/sistema/kiosco), fecha/hora del servidor, acción, entidad, valores **anterior y nuevo**, motivo e IP.
- **RN-AUD-03** Solo-agregar; reforzado en BD con trigger y sin privilegios de `UPDATE`/`DELETE`/`TRUNCATE`.
- **RN-AUD-04** Se escribe **en la misma transacción** que el cambio.
- **RN-AUD-05** Cada negocio consulta solo su auditoría. Las operaciones de plataforma van en una bitácora aparte.
- **RN-AUD-06** La auditoría **nunca** contiene PIN, hash de PIN, contraseñas ni tokens.

## 18. Internacionalización

- **RN-I18N-01** Interfaz inicialmente en **español**, con **todos los textos mediante un sistema de traducciones** desde el principio. No hace falta implementar inglés todavía.
- **RN-I18N-02** Código, tablas, columnas, enums y nombres internos en **inglés**.

## 19. Fuera del alcance (la arquitectura lo prevé)

Pagos, cobros y facturación · autoservicio de alta/onboarding por el propio cliente · subdominios por negocio · recuperación de contraseña por correo · alta de usuarios por el administrador del negocio (invitaciones) · QR / cámara / biometría · **modo offline real** · vacaciones, permisos, incapacidades · días festivos · horas extra, nómina, periodos de pago y cualquier cálculo de pago · reglas "N retardos = 1 falta" · notificaciones · PDF · rol de RH · módulos futuros (mesas, adelantos, nómina, comunicados) · aprobación multinivel o "aprobar con ajuste" · reportes programados o por correo.

## 20. Planes y suscripciones (Fase 5)

- **RN-PLAN-01** La plataforma se administra desde una **consola separada** de la app de los negocios; sus operadores no son usuarios de ningún negocio.
- **RN-PLAN-02** Los operadores inician sesión con credenciales propias; todas sus acciones quedan en la bitácora de plataforma (sin contraseñas ni tokens).
- **RN-PLAN-03** Existen **planes** con límites de sucursales, empleados activos, kioscos activos y usuarios, y con funciones (exportar reportes, plantillas de horario). Los dos planes iniciales (Básico y Avanzado) los edita un operador; un plan inactivo no se asigna a negocios nuevos.
- **RN-PLAN-04** Cada negocio tiene **una suscripción** (plan, estado y vigencia fijados a mano; **sin pagos**). Solo `TRIAL` y `ACTIVE` operan; `SUSPENDED`, `EXPIRED` y `CANCELLED` suspenden el acceso de inmediato. **Ningún dato se borra** al suspender, vencer o cancelar, y se puede reactivar.
- **RN-PLAN-05** Los límites cuentan **solo registros activos**; desactivar o dar de baja libera cupo. El límite lo hace cumplir PostgreSQL además del servicio.
- **RN-PLAN-06** **Bajar de plan nunca borra ni desactiva datos**: solo impide crear o reactivar por encima del nuevo límite (el operador ve un aviso con lo que ya excede).
- **RN-PLAN-07** El negocio ve su plan, estado, vigencia, límites y uso; nunca las notas internas ni datos de otros negocios.
- **RN-PLAN-08** Todo cambio de plan, estado o vigencia queda en un historial inmutable con el responsable.
- **RN-PLAN-09** Un cliente nuevo se crea con negocio, sucursales, primer administrador y suscripción en una sola operación; la contraseña inicial se muestra una vez.
- **RN-PLAN-10** Todo negocio tiene siempre una suscripción (los existentes y los creados por CLI quedan en Avanzado/Activo, sin vencimiento).

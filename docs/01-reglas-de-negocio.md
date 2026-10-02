# 01 · Reglas de negocio — Reloj checador (plataforma multi-negocio)

> **Versión 1.0 — CONGELADA.** Cambios posteriores requieren una decisión explícita y quedan anotados en `00-decisiones.md`.
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
| **Jornada** (`attendance_record`) | Lo que *realmente* ocurrió para un turno: Entrada → Salida, con sus cálculos. |
| **Pausa / comida** (`attendance_break`) | Registro independiente de una salida a comer y su regreso, dentro de una jornada. |
| **Checada** (`punch_event`) | Evento individual (Entrada, Salida, Salida a comer, Regreso de comer). **Inmutable.** |
| **Corrección** | Registro que agrega, anula o ajusta una checada. Nunca edita la original. |
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
- **RN-OPE-04** Una jornada abierta se marca como **olvido de salida** al llegar el **primer corte operativo posterior al fin programado de su turno**. Sin turno: el primer corte posterior a la Entrada que además ocurra al menos `max_hours_unscheduled` (14 h) después.
- **RN-OPE-05** Detección en dos momentos: proceso automático cada minuto y **al identificarse el empleado** si su jornada abierta ya terminó su turno y se abrió la ventana de otro turno suyo (así nunca queda "atorado").
- **RN-OPE-06** Al marcarla: estado `REVIEW`, `actual_out` vacío, horas trabajadas **no calculadas** ("incompleta"), incidencia `SALIDA_FALTANTE` y **requiere corrección**. No bloquea nuevas entradas.
- **RN-OPE-07** La corrección agrega la salida real que confirme el encargado, con motivo; la jornada se recalcula.

## 6. Identificación en el kiosco (PIN)

- **RN-PIN-01** **PIN de 6 dígitos generado por el sistema** (aleatorio criptográfico; se descartan PIN triviales como 000000 o 123456).
- **RN-PIN-02** Único entre **empleados activos del mismo negocio**; no global. **El mismo PIN puede existir en dos negocios**.
- **RN-PIN-03** **Nunca se guarda en texto plano**: solo un hash con secreto del servidor (`HMAC-SHA-256(pepper, organización ‖ PIN)`).
- **RN-PIN-04** **Solo se muestra una vez**, al generarlo o restablecerlo. No existe forma de consultarlo después.
- **RN-PIN-05** El empleado **no puede cambiarlo** en el MVP. Lo genera/restablece el administrador o el encargado con permiso.
- **RN-PIN-06** **Restablecer invalida inmediatamente el anterior.** La baja del empleado invalida el PIN.
- **RN-PIN-07** Auditoría del alta/restablecimiento (quién, cuándo, a quién), **sin registrar nunca el PIN** ni su hash.
- **RN-PIN-08** **Protección contra intentos masivos:** `pin_max_attempts` (5) fallos consecutivos en un kiosco ⇒ bloqueo `pin_lockout_sec` (60 s). Todo intento se registra. Mensaje de error genérico ("Código no válido") que no revela si el PIN existe.
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

## 8. Horarios y turnos

- **RN-HOR-01** Un turno define empleado, sucursal, fecha laboral y hora local de inicio y fin. Si fin ≤ inicio, termina al día siguiente (19:00–03:00). Se guardan los instantes UTC calculados con la zona efectiva de la sucursal.
- **RN-HOR-02** Duración válida: default entre 1 y 16 h.
- **RN-HOR-03** **Sin turnos traslapados** por empleado (restricción en BD).
- **RN-HOR-04** **Programación semanal** por sucursal; la semana inicia según `week_start_day` (default lunes; configurable por negocio). `BORRADOR` → `PUBLICADA`; el empleado solo ve lo publicado.
- **RN-HOR-05** Plantillas de turno y copiar la semana anterior.
- **RN-HOR-06** Día sin turno = descanso, no genera falta.
- **RN-HOR-07** Cambiar/cancelar un turno publicado requiere permiso, motivo y auditoría; si hay jornada, se recalcula. Los turnos pasados con jornada solo los modifica el administrador.
- **RN-HOR-08** Programan: administrador y encargado **solo con permiso** `schedules.manage` en su alcance.

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
| `exit_tolerance_min` | 0 | negocio · sucursal · empleado |
| `max_breaks` | 1 | negocio · sucursal · empleado |
| `break_allowed_min` (por pausa) | 35 | negocio · sucursal · empleado |
| `break_tolerance_min` | 0 | negocio · sucursal · empleado |
| `require_break` | no | negocio · sucursal · empleado |
| `early_entry_window_min` | 60 | negocio · sucursal |
| `absent_after_min` (estado "Ausente") | 60 | negocio · sucursal |
| `operational_cutoff` (hora) | 05:00 | negocio · sucursal |
| `max_hours_unscheduled` | 14 | negocio · sucursal |
| `debounce_sec` | 60 | negocio · sucursal |
| `pin_max_attempts` | 5 | negocio · sucursal |
| `pin_lockout_sec` | 60 | negocio · sucursal |
| `week_start_day` (1 = lunes) | 1 | negocio |

La zona horaria **no es una política**: es un atributo del negocio (obligatorio) y de la sucursal (opcional).

- **RN-CFG-04** Ejemplo: Fatboy `break_allowed_min` = 35; San Marcos hereda 35; Venecia define 40; el empleado X en Venecia define 30 ⇒ efectivo para X = **30**; para otro empleado de Venecia = 40; en San Marcos = 35.
- **RN-CFG-05** Ningún negocio lee ni modifica la configuración de otro. Los cambios se auditan y aplican hacia adelante (RN-CAL-05).
- **RN-CFG-06** Los valores se validan en la aplicación **y** con restricciones en la base de datos (rangos y niveles permitidos).

## 11. Incidencias y estados de llegada

- **RN-INC-01** Tipos: `SALIDA_FALTANTE`, `ENTRADA_FALTANTE`, `REGRESO_COMIDA_FALTANTE`, `SALIDA_COMIDA_FALTANTE`, `COMIDA_EXCEDIDA`, `RETARDO`, `FALTA`, `SALIDA_ANTICIPADA`, `SIN_TURNO_PROGRAMADO`, `SIN_ASIGNACION_SUCURSAL`, `SIN_COMIDA`.
- **RN-INC-02** Las genera el **sistema**; el empleado nunca las crea ni edita.
- **RN-INC-03** `ABIERTA` → `RESUELTA` con resolución `CORREGIDA`, `JUSTIFICADA`, `CONFIRMADA` o `DESCARTADA`, siempre con motivo, usuario y fecha.
- **RN-INC-04** Los reportes distinguen confirmados de justificados.
- **RN-INC-05** El empleado puede consultar (solo lectura) sus incidencias en el kiosco.
- **RN-INC-06** **Estados de llegada (separados):**

| Estado | Cuándo |
|---|---|
| **A tiempo** | Entrada dentro de la tolerancia |
| **Retardo / Aún no llega** | Pasó la tolerancia y no hay Entrada (o, con Entrada, llegó tarde) |
| **Ausente / No ha llegado** | Pasaron `absent_after_min` (60) sin Entrada. **No es definitivo**: todavía puede llegar |
| **Trabajando** | Ya checó Entrada (conserva el retardo real completo si lo hubo) |
| **Falta** | **Solo** cuando el turno terminó y nunca hubo Entrada |

## 12. Correcciones

- **RN-COR-01** El empleado no puede corregir nada.
- **RN-COR-02** Una corrección puede agregar, anular o cambiar la hora de una checada (anular + agregar). **Motivo obligatorio siempre.**
- **RN-COR-03** **Siempre se conserva la original** (nunca se borra ni reemplaza en silencio) y hay **auditoría antes/después**.
- **RN-COR-04** **Encargado:** corrige jornadas **ocurridas en sus sucursales**, sin importar la sucursal habitual del empleado.
- **RN-COR-05** **Nadie puede corregir su propia jornada.** La de un encargado la corrige otro encargado con permiso sobre esa sucursal o un administrador.
- **RN-COR-06** **Administrador:** puede corregir empleados y encargados **dentro de su negocio** (nunca de otro), excepto su propia jornada.
- **RN-COR-07** Existe `attendance.correction.request` (solicitar con aprobación) para roles futuros, sin código nuevo.
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
- **RN-IDN-03** Mientras no exista recuperación automática, el **restablecimiento global lo realiza la plataforma**. La **recuperación por correo** queda preparada para una fase posterior.
- **RN-IDN-04** Login: correo + contraseña. Si el usuario pertenece a un negocio entra directo; si pertenece a varios, **elige negocio**. El negocio queda fijado en la sesión.
- **RN-IDN-05** Cada negocio debe tener siempre al menos un administrador activo.
- **RN-IDN-06** Cambios de rol, permiso, alcance o membresía se auditan.

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
| Programar horarios | — | con permiso | ✅ |
| Altas, bajas, PIN, asignaciones | — | opcional por permiso | ✅ |
| Sucursales, kioscos, configuración, roles, membresías | — | — | ✅ |
| Reportes y exportación | — | su alcance | ✅ |
| Auditoría | — | — | ✅ |

- **RN-ROL-01** El empleado no tiene cuenta web (acceso desde celular: mejora futura).
- **RN-ROL-02** Roles y permisos son **por negocio**.
- **RN-ROL-03** Un encargado nunca ve datos fuera de su alcance, aunque conozca identificadores.

## 15. Tablero en tiempo real

Muestra los estados de §11 (RN-INC-06) más: **En comida** (minutos transcurridos; rojo si excede), **Salió** y **Revisión**.

- **RN-RT-01** Incluye turnos nocturnos que iniciaron "ayer" y siguen abiertos. "Hoy" = **día operativo** de la sucursal.
- **RN-RT-02** Actualización ≤ 2 s tras una checada; estados dependientes del tiempo cada ~30 s.
- **RN-RT-03** Cada usuario recibe solo su negocio y las sucursales de su alcance.

## 16. Reportes y exportación

- **RN-REP-01** Filtros: empleado, sucursal y rango. Por **fecha laboral**, solo dentro del negocio y alcance.
- **RN-REP-02** **Accesos rápidos:** Hoy · Ayer · Esta semana · Semana pasada · 1–15 · 16–fin de mes · Este mes · Mes pasado · Rango personalizado. Se calculan en la zona de la sucursal; "Hoy/Ayer" usan el día operativo; "Semana" usa `week_start_day`.
- **RN-REP-03** Métricas: horas programadas, horas trabajadas, retardos (y minutos), faltas, pausas (duración y exceso por pausa y acumulado), salidas anticipadas, incidencias y correcciones.
- **RN-REP-04** Jornadas corregidas visibles con acceso al antes/después.
- **RN-REP-05** Exportación a **Excel** (MVP) y **PDF** (después); se audita.
- **RN-REP-06** **No existe entidad "periodo de pago"** por ahora; el diseño no impide agregarla (junto con nómina) más adelante.

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

Facturación, suscripciones, planes, pagos y onboarding comercial · UI de administración de plataforma · subdominios por negocio · recuperación de contraseña por correo · alta de usuarios por el administrador del negocio (invitaciones) · QR / cámara / biometría · **modo offline real** · vacaciones, permisos, incapacidades · días festivos · horas extra, nómina, periodos de pago y cualquier cálculo de pago · reglas "N retardos = 1 falta" · notificaciones · PDF · rol de RH · módulos futuros (mesas, adelantos, nómina, comunicados, solicitudes).

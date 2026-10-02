# 01 · Reglas de negocio — Reloj checador (plataforma multi-negocio)

> Estado: **BORRADOR para validar**. Fatboy es el **primer negocio (tenant)** de la plataforma, pero ninguna regla ni dato está diseñado específicamente para Fatboy.
> Los valores `default` son propuestas y se configuran. Decisiones abiertas: `docs/00-decisiones-pendientes.md` (referenciadas como **[D-n]**).

## 1. Glosario

| Término | Significado |
|---|---|
| **Plataforma** | El sistema completo, que aloja a varios negocios. |
| **Negocio / Organización** (tenant) | Cliente independiente de la plataforma (ej. Fatboy, Pizzería X). Sus datos jamás se mezclan con los de otro negocio. En datos se identifica con `organization_id`. |
| **Sucursal** | Local físico de un negocio. Tiene zona horaria y hora de corte operativo propias. |
| **Empleado** | Persona de un negocio que checa. Se identifica con PIN. No tiene usuario/contraseña. |
| **Usuario** | Cuenta de acceso al panel web (dueño/administrador, encargado). Una persona = una cuenta, aunque tenga acceso a varias sucursales. |
| **Kiosco** | Tablet registrada, ligada a un negocio y a una sucursal. |
| **Turno programado** (`shift`) | Lo que *debería* trabajar un empleado: sucursal + inicio + fin. |
| **Jornada** (`attendance_record`) | Lo que *realmente* ocurrió para un turno: de la Entrada a la Salida, con sus cálculos. |
| **Checada** (`punch_event`) | Evento individual: Entrada, Salida, Salida a comer, Regreso de comer. **Inmutable.** |
| **Corrección** | Registro que agrega, anula o ajusta una checada. Nunca edita la original. |
| **Incidencia** | Anomalía que requiere atención o justificación. |
| **Fecha laboral** (`business_date`) | Fecha *local* en que **inicia** el turno. Un turno 7 PM → 3 AM del 15 pertenece al día 14. |
| **Hora de corte operativo** | Hora local, definida por sucursal, que separa un día operativo del siguiente (ej. 05:00). |
| **Día operativo** | Intervalo entre dos cortes consecutivos. Permite que jornadas que cruzan la medianoche pertenezcan al día correcto. |

## 2. Principios (no negociables)

1. **La jornada manda, no el día calendario.** Todo se agrupa por turno/jornada y fecha laboral.
2. **El servidor es la única fuente de hora.** La hora de una checada la pone el servidor, no la tablet.
3. **Las checadas son inmutables.** Se corrige agregando registros, nunca modificando ni borrando.
4. **Nada se borra físicamente:** se desactiva o se cancela.
5. **Cero reglas quemadas:** tolerancias, tiempos y umbrales viven en configuración.
6. **Toda acción administrativa importante queda en auditoría** con quién, cuándo, negocio, sucursal, antes y después.
7. **El servidor valida todo.** La pantalla solo *muestra*; el backend *impone*.
8. **El aislamiento entre negocios se impone en backend y en base de datos**, nunca solo ocultando información en el frontend.
9. **El sistema nunca inventa datos** (por ejemplo, una hora de salida que nadie registró).

## 3. Negocios (multi-tenant)

- **RN-ORG-01** Jerarquía: **Plataforma → Negocio → Sucursales → Empleados**. Cada negocio funciona como un tenant independiente.
- **RN-ORG-02** Todo dato que pertenece a un negocio lleva su `organization_id` obligatorio: sucursales, empleados, asignaciones, accesos de usuarios, kioscos y sus tokens, PIN, plantillas, horarios, turnos, jornadas, checadas, anulaciones, correcciones, incidencias, políticas, configuraciones, auditoría y todo lo que alimenta reportes.
- **RN-ORG-03** **Ninguna entidad puede referenciar otra de un negocio distinto** (ej. un turno de un negocio no puede apuntar a un empleado de otro). Lo garantiza la base de datos, no solo la aplicación.
- **RN-ORG-04** El negocio activo de cada petición **se deduce de la sesión autenticada o del token del kiosco, jamás de un parámetro que envíe el cliente**.
- **RN-ORG-05** El aislamiento se aplica en tres capas: (1) autenticación/autorización en el backend, (2) filtro obligatorio por negocio en el acceso a datos, (3) **seguridad a nivel de fila en PostgreSQL** (RLS) que impide leer o escribir filas de otro negocio aunque el código tuviera un error.
- **RN-ORG-06** Un **usuario** es una identidad única que puede pertenecer a más de un negocio, pero **opera en un solo negocio a la vez** (el de su sesión). Cambiar de negocio exige elegirlo explícitamente **[D-19]**.
- **RN-ORG-07** Dentro de un negocio, un usuario puede tener acceso a **una, varias o todas** las sucursales **sin duplicar su cuenta**.
- **RN-ORG-08** Un negocio puede estar `ACTIVO` o `SUSPENDIDO`. Suspendido: nadie accede ni se puede checar, pero **no se pierde ningún dato**. (Solo el estado; sin lógica comercial.)
- **RN-ORG-09** Cada negocio tiene su propia identidad visual (nombre y logo que se muestran en el kiosco y panel), zona horaria por defecto y configuración. Nada de "Fatboy" va fijo en el código.
- **RN-ORG-10** El alta de un negocio nuevo y de su primer administrador se hace por una **herramienta administrativa interna** (script/CLI). Fuera de alcance por ahora: facturación, suscripciones, planes, pagos y onboarding comercial.
- **RN-ORG-11** Las pruebas automáticas incluyen **pruebas de aislamiento**: comprobar que cada tabla de datos de negocio tiene RLS activo y que un negocio no puede ver ni modificar datos de otro. Una tabla nueva sin esa protección rompe la integración continua.

## 4. Sucursales y asignaciones

- **RN-SUC-01** Cada sucursal tiene una zona horaria IANA (`default` la del negocio, ej. `America/Mexico_City`) **[D-1]**. Todo se guarda en UTC y se interpreta en la zona de la sucursal.
- **RN-SUC-02** Todo empleado tiene **exactamente una asignación PRIMARIA vigente**. Cambiar de sucursal base cierra la anterior y abre otra; el historial se conserva.
- **RN-SUC-03** Un empleado puede tener **asignaciones TEMPORALES** a otras sucursales **del mismo negocio** con rango de fechas y motivo.
- **RN-SUC-04** El kiosco determina el negocio y la sucursal; nunca el cliente. Si un empleado checa en una sucursal donde **no tiene asignación vigente**, **se permite** y se marca con incidencia `SIN_ASIGNACION_SUCURSAL` para revisión (no se bloquea por un error administrativo) **[D-17]**.
- **RN-SUC-05** Programar un turno en una sucursal requiere asignación vigente del empleado en ella para esa fecha.
- **RN-SUC-06** Visibilidad: el administrador ve todas las sucursales **de su negocio**; el encargado ve las sucursales de su alcance: sus empleados con asignación vigente y las jornadas ocurridas en ellas.
- **RN-SUC-07** Las jornadas guardan la sucursal **donde se trabajó**; los reportes por sucursal usan ese dato.
- **RN-SUC-08** Cada sucursal define su **hora de corte operativo** (ver §5) **[D-9]**.

## 5. Día operativo y jornadas abiertas (olvido de salida)

- **RN-OPE-01** Cada sucursal tiene una **hora de corte operativo** configurable (hora local, `default` 05:00). Un **día operativo** va de un corte al siguiente. Sirve para que jornadas que terminan después de medianoche pertenezcan al día correcto.
- **RN-OPE-02** Para una checada **sin turno**, la fecha laboral es la del día operativo en que ocurre la Entrada (con corte 05:00, una Entrada a la 01:00 pertenece al día operativo anterior).
- **RN-OPE-03** **El sistema NUNCA inventa una hora de salida.** Una jornada que queda abierta se detecta, se marca y requiere corrección humana.
- **RN-OPE-04** Una jornada abierta se marca como **olvido de salida** cuando llega el **primer corte operativo posterior al fin programado de su turno**. Sin turno: el primer corte posterior a su Entrada que además ocurra al menos `max_horas_jornada_sin_turno` (`default` 14 h) después de ella.
- **RN-OPE-05** Detección en dos momentos: (a) proceso automático cada minuto; (b) **al identificarse el empleado**, si su jornada abierta ya terminó su turno y ya abrió la ventana de entrada de otro turno suyo, la anterior se marca como olvidada en ese instante (así nunca queda "atorado" sin poder checar Entrada).
- **RN-OPE-06** Al marcarla: estado `REVISION`, `actual_out` queda vacío, las horas trabajadas **no se calculan** (la jornada se muestra como "incompleta"), se crea la incidencia `SALIDA_FALTANTE` y se **requiere corrección**. Una jornada marcada **no bloquea** nuevas entradas.
- **RN-OPE-07** La corrección agrega la salida real (según lo que confirme el encargado) con motivo; la jornada se recalcula (ver §12).

## 6. Identificación en el kiosco (PIN)

- **RN-PIN-01** El PIN es numérico. Longitud configurable, `default` 6 dígitos, mínimo 4 **[D-8]**.
- **RN-PIN-02** El PIN es **único entre los empleados activos del mismo negocio** (se identifica solo con el PIN, sin usuario). Dos negocios pueden tener el mismo PIN sin relación alguna.
- **RN-PIN-03** El PIN nunca se guarda en claro ni se puede consultar: solo se puede **generar uno nuevo** (se muestra una sola vez).
- **RN-PIN-04** Intentos fallidos: `default` 5 consecutivos en un kiosco ⇒ bloqueo de 60 s. Todos se registran.
- **RN-PIN-05** Mensaje de error genérico ("Código no válido").
- **RN-PIN-06** Un kiosco se **empareja** desde el panel (código de un solo uso) y queda ligado a un negocio y una sucursal. Su token solo sirve para ese negocio y esa sucursal, y es revocable.
- **RN-PIN-07** Tras identificarse, la sesión del empleado es corta: termina al completar la acción o tras `default` 20 s de inactividad.
- **RN-PIN-08** Tras una checada exitosa se muestra confirmación (nombre, acción, hora del servidor) unos 4 s y se regresa a la pantalla inicial.

## 7. Checadas: eventos y máquina de estados

| Estado de la jornada | Acciones disponibles |
|---|---|
| Sin jornada abierta | **Entrada** |
| `TRABAJANDO` | **Salida**, **Salida a comer** |
| `EN_COMIDA` | **Regreso de comer** (solo esta) |

- **RN-EVT-01** El backend rechaza cualquier transición fuera de esa tabla, dentro de **una transacción con bloqueo**, de modo que dos toques simultáneos no generen duplicados.
- **RN-EVT-02** **Antirrebote:** una checada del mismo empleado a menos de `default` 60 s de la anterior se rechaza ("ya registrado"). Cada envío lleva un identificador de idempotencia: reintentos de red no duplican.
- **RN-EVT-03** Máximo de comidas por jornada: `default` 1 **[D-14]**.
- **RN-EVT-04** Un empleado tiene **a lo más una jornada abierta** a la vez (garantizado por la base de datos).
- **RN-EVT-05** **Entrada ligada a turno:** se busca el turno programado del empleado en esa sucursal cuya ventana contenga la hora actual: desde `inicio − ventana_entrada_anticipada` (`default` 60 min) hasta el fin del turno **[D-5]**. Si hay varios, el más cercano al inicio.
- **RN-EVT-06** **Sin turno programado: la checada SE PERMITE.** No se bloquea al empleado por un error administrativo. Se registra normal y queda marcada como **"SIN TURNO PROGRAMADO"** (`SIN_TURNO`) para revisión del encargado.
- **RN-EVT-07** **Turnos nocturnos:** la Salida y la Comida se agregan a la **jornada abierta** del empleado aunque ya sea otro día calendario. La jornada conserva la fecha laboral de su Entrada.
- **RN-EVT-08** Estando `EN_COMIDA` no se permite Salida: primero Regreso. Si olvidó el regreso, el tiempo de comida saldrá excesivo y quedará para corrección.
- **RN-EVT-09** Jornada abierta vencida: ver §5 (RN-OPE).
- **RN-EVT-10** El kiosco no permite modificar ni cancelar una checada ya hecha.
- **RN-EVT-11** **Olvido de Entrada:** si olvidó checar al llegar, el kiosco solo le ofrecerá "Entrada" cuando quiera salir. Si esa Entrada cae después del fin de su turno, se registra y se marca `ENTRADA_FALTANTE`; el encargado la resuelve con una corrección.

## 8. Horarios y turnos

- **RN-HOR-01** Un turno define empleado, sucursal, fecha laboral, hora local de inicio y de fin. Si el fin es **menor o igual** al inicio, termina al día siguiente (ej. 19:00–03:00). El sistema guarda los instantes UTC exactos.
- **RN-HOR-02** Duración válida: `default` entre 1 y 16 horas.
- **RN-HOR-03** **Sin turnos traslapados** para un empleado (restricción en BD). Se permiten varios turnos el mismo día sin traslape.
- **RN-HOR-04** **Programación semanal** por sucursal; la semana inicia en `default` lunes **[D-10]**. Estados `BORRADOR` → `PUBLICADA`. El empleado solo ve horarios publicados.
- **RN-HOR-05** **Plantillas de turno** y **copiar la semana anterior**.
- **RN-HOR-06** Un día sin turno es **descanso**: no genera falta.
- **RN-HOR-07** Cambiar o cancelar un turno publicado requiere permiso, motivo y auditoría con antes/después. Si ya hay jornada, se **recalcula**. Los turnos pasados con jornada solo los modifica el administrador del negocio.
- **RN-HOR-08** Programan: el administrador del negocio y el encargado **solo con permiso** `schedules.manage` en su alcance.

## 9. Cálculo de asistencia

Variables: `Hp_ini`/`Hp_fin` = inicio/fin **programados**; `Hr_ini`/`Hr_fin` = primera Entrada / última Salida **reales**. Los segundos se truncan antes de comparar (7:10:59 cuenta como 7:10).

| Resultado | Regla |
|---|---|
| **Diferencia de entrada** | `Hr_ini − Hp_ini` en minutos (negativa = llegó antes). Se **guarda siempre** como dato real |
| **A tiempo** | `Diferencia ≤ tolerancia_entrada`. No genera incidencia |
| **Retardo** | `Diferencia > tolerancia_entrada`. **Genera incidencia y registra los minutos reales completos** (`late_minutes = Diferencia`) **[D-3]** |
| **Falta** | No hubo Entrada al terminar el turno (la registra el sistema). Opcional: retardo mayor a `retardo_cuenta_como_falta_min` (`default` apagado) |
| **Salida anticipada** | `Hr_fin < Hp_fin − tolerancia_salida`, solo si existe la Salida |
| **Horas programadas** | `Hp_fin − Hp_ini` |
| **Horas trabajadas** | `Hr_fin − Hr_ini`. **No se descuenta la comida.** Vacío si la jornada está incompleta |
| **Tiempo de comida** | Suma de (`Regreso − Salida a comer`). Informativo |
| **Exceso de comida** | `max(0, Tiempo de comida − comida_permitida_min − tolerancia_comida_min)` |

> Ejemplo (tolerancia 10): turno 7:00 → entra 7:08 ⇒ **a tiempo**, diferencia 8 min guardada, sin incidencia. Entra 7:12 ⇒ **retardo de 12 min** reales, con incidencia.

- **RN-CAL-01** La entrada anticipada se registra con la hora real; la diferencia contra lo programado se muestra en el reporte.
- **RN-CAL-02** **La comida es solo control de tiempo e incidencias.** Registra salida, regreso y duración. **No descuenta horas, no calcula pagos ni afecta nómina** (ni tiene relación con el costo de alimentos). Con 30 min permitidos y 42 de duración: duración 42, exceso 12, incidencia `COMIDA_EXCEDIDA`. `default` **35 min**, tolerancia 0, **configurables por negocio, por sucursal y por empleado** (excepciones).
- **RN-CAL-03** Comida con salida pero sin regreso ⇒ incidencia `REGRESO_COMIDA_FALTANTE`.
- **RN-CAL-04** Opcional: `requiere_comida` (`default` apagado) ⇒ incidencia `SIN_COMIDA`.
- **RN-CAL-05** Los resultados se guardan con **una copia de los parámetros usados**. Cambiar una tolerancia hoy **no modifica silenciosamente** el pasado; solo se recalcula con corrección o reproceso explícito (auditado).
- **RN-CAL-06** Los cálculos viven en una **función pura** con pruebas automáticas (nocturnos, zonas horarias, cortes operativos).

## 10. Configuración (sin reglas en código)

- **RN-CFG-01** Políticas en cascada: **Empleado > Sucursal > Negocio**; lo no definido hereda. La política del negocio siempre está completa y se crea al dar de alta el negocio con valores iniciales.
- **RN-CFG-02** Cada negocio configura lo suyo; **ningún negocio puede leer ni modificar la configuración de otro**. Todo cambio se audita y aplica hacia adelante (RN-CAL-05).
- **RN-CFG-03** Parámetros iniciales:

| Parámetro | Default | Nivel |
|---|---|---|
| `tolerancia_entrada_min` | 10 | negocio/sucursal/empleado |
| `tolerancia_salida_min` | 0 | idem |
| `retardo_cuenta_como_falta_min` | apagado | idem |
| `umbral_no_se_presento_min` (tablero) | 60 **[D-4]** | idem |
| `ventana_entrada_anticipada_min` | 60 **[D-5]** | idem |
| `comida_permitida_min` | **35** | negocio/sucursal/**empleado** |
| `tolerancia_comida_min` | 0 | idem |
| `max_comidas_por_jornada` | 1 | idem |
| `requiere_comida` | no | idem |
| `max_horas_jornada_sin_turno` | 14 | negocio/sucursal |
| `antirrebote_seg` | 60 | negocio |
| `pin_longitud` | 6 | negocio |
| `pin_intentos_max` / `pin_bloqueo_seg` | 5 / 60 | negocio |
| `kiosco_inactividad_seg` | 20 | negocio |
| `inicio_de_semana` | lunes **[D-10]** | negocio |
| **`hora_corte_operativo`** | 05:00 | **sucursal** |
| `zona_horaria` | del negocio | negocio/sucursal |

## 11. Incidencias

- **RN-INC-01** Tipos iniciales: `SALIDA_FALTANTE`, `ENTRADA_FALTANTE`, `REGRESO_COMIDA_FALTANTE`, `SALIDA_COMIDA_FALTANTE`, `COMIDA_EXCEDIDA`, `RETARDO`, `FALTA`, `SALIDA_ANTICIPADA`, `SIN_TURNO` (se muestra como **"Sin turno programado"**), `SIN_ASIGNACION_SUCURSAL`, `SIN_COMIDA`.
- **RN-INC-02** Las genera el **sistema**. El empleado nunca las crea ni edita.
- **RN-INC-03** Ciclo de vida: `ABIERTA` → `RESUELTA` con resolución `CORREGIDA`, `JUSTIFICADA`, `CONFIRMADA` o `DESCARTADA`; siempre con motivo, usuario y fecha.
- **RN-INC-04** Los reportes distinguen **confirmados** de **justificados**.
- **RN-INC-05** El empleado puede consultar (solo lectura) sus incidencias en el kiosco.

## 12. Correcciones

- **RN-COR-01** El empleado **no** puede corregir nada.
- **RN-COR-02** Una corrección puede **agregar** una checada faltante, **anular** una errónea o **cambiar la hora** (anular + agregar). **Motivo obligatorio** siempre.
- **RN-COR-03** La checada original **nunca se borra ni se reemplaza en silencio**. Se conserva: original, corrección, quién, cuándo y motivo.
- **RN-COR-04** **Encargado:** puede aplicar correcciones **directamente**, **solo sobre jornadas de las sucursales de su alcance** (donde se trabajó), con motivo obligatorio y auditoría completa. **Administrador del negocio:** cualquier sucursal **de su negocio**. Nadie puede corregir datos de otro negocio. **No se permite corregir la propia jornada** **[D-7, D-18]**.
- **RN-COR-05** Existe el permiso `attendance.correction.request` (solicitar con aprobación) para roles futuros, sin código nuevo.
- **RN-COR-06** Al aplicarse, la jornada se recalcula y la incidencia relacionada pasa a `CORREGIDA`.
- **RN-COR-07** No puede quedar una secuencia ilógica (Salida antes de Entrada, etc.); se valida antes de aplicar.

## 13. Empleados

- **RN-EMP-01** Nunca se borra un empleado: `ACTIVO` / `INACTIVO` con fecha y motivo.
- **RN-EMP-02** Baja: se invalida el PIN, se cancelan turnos futuros (auditado) y el historial queda intacto.
- **RN-EMP-03** Reingreso: se reactiva el mismo registro con nuevo PIN y nueva asignación primaria.
- **RN-EMP-04** El número de empleado es único **dentro del negocio**.

## 14. Roles y permisos

Modelo: **roles con permisos granulares**; cada asignación de rol a un usuario tiene un **alcance** dentro de su negocio: *todas las sucursales* o *una lista de sucursales*.

| Rol | Alcance típico |
|---|---|
| **Administrador / Dueño del negocio** | Todas las sucursales de su negocio: sucursales, empleados, horarios, asistencias, incidencias, correcciones, reportes, configuración, auditoría, kioscos, roles |
| **Encargado de sucursal** | Solo las sucursales asignadas (una o varias, con la misma cuenta) |
| **Empleado** | Sin cuenta web; opera en el kiosco con PIN |
| *Administrador de plataforma* | Fuera del producto por ahora: operaciones internas por script |

| Capacidad | Empleado | Encargado | Administrador del negocio |
|---|:-:|:-:|:-:|
| Checar | ✅ | ✅ (es empleado) | ✅ si es empleado |
| Ver sus propias asistencias, horarios e incidencias (en kiosco) | ✅ | ✅ | ✅ |
| Ver empleados de su alcance | — | ✅ | ✅ |
| Asistencia del día / quién trabaja ahora | — | ✅ | ✅ |
| Retardos, faltas y comidas | — | ✅ | ✅ |
| Resolver incidencias | — | ✅ | ✅ |
| Aplicar correcciones (no las propias) | — | ✅ su alcance | ✅ |
| Programar horarios | — | solo con permiso | ✅ |
| Alta/baja/edición de empleados, PIN, asignaciones | — | opcional por permiso | ✅ |
| Sucursales, kioscos, configuración, roles | — | — | ✅ |
| Reportes y exportación | — | su alcance | ✅ |
| Consultar auditoría | — | — | ✅ |

- **RN-ROL-01** El empleado no tiene cuenta web. (Acceso desde su celular: mejora futura.)
- **RN-ROL-02** Encargados y administradores entran al panel con **correo y contraseña** **[D-11]**.
- **RN-ROL-03** Cambios de rol, permiso o alcance se auditan.
- **RN-ROL-04** Cada negocio debe tener siempre al menos un administrador activo.
- **RN-ROL-05** Los roles y sus permisos son **por negocio**: un negocio puede crear roles propios sin afectar a otros.
- **RN-ROL-06** Un encargado nunca ve ni consulta datos fuera de su alcance, aunque conozca los identificadores; el backend filtra por alcance en cada consulta.

## 15. Tablero en tiempo real

| Estado mostrado | Cuándo |
|---|---|
| **Trabajando** | Jornada `TRABAJANDO` |
| **En comida** (minutos transcurridos; rojo si excede) | Jornada `EN_COMIDA` |
| **Por llegar** | Turno por iniciar o ya iniciado dentro de la tolerancia |
| **Retardo** | Sin Entrada y ya pasó `tolerancia_entrada` |
| **No se presentó** | Sin Entrada y ya pasó `umbral_no_se_presento_min` |
| **Salió** | Jornada cerrada hoy |
| **Revisión** | Jornada con incidencia abierta de checada faltante |

- **RN-RT-01** Incluye turnos nocturnos que iniciaron "ayer" y siguen abiertos (por jornada abierta y ventana de turno, no por fecha calendario). El "hoy" es el **día operativo** de la sucursal.
- **RN-RT-02** Actualización ≤ 2 s tras una checada; los estados que cambian solo con el tiempo se refrescan cada ~30 s.
- **RN-RT-03** Cada usuario solo recibe actualizaciones de **su negocio y de las sucursales de su alcance**.

## 16. Reportes y exportación

- **RN-REP-01** Filtros: empleado, sucursal, día, semana, periodo personalizado; siempre por **fecha laboral** y **solo dentro del negocio y alcance** del usuario.
- **RN-REP-02** Métricas: horas programadas, horas trabajadas, retardos (y minutos), faltas, tiempo y exceso de comida, salidas anticipadas, incidencias (abiertas/justificadas) y correcciones.
- **RN-REP-03** Jornadas corregidas visibles, con acceso al antes/después.
- **RN-REP-04** Exportación a **Excel** (MVP) y **PDF** (después); la exportación se audita.
- **RN-REP-05** Rangos interpretados en la zona horaria de cada sucursal.

## 17. Auditoría

- **RN-AUD-01** Se audita como mínimo: empleados (alta/edición/baja), cambios de sucursal o asignación, turnos y horarios, correcciones, resolución de incidencias, roles/permisos/alcances, configuración, kioscos (alta/revocación), reinicio de PIN, reprocesos, exportaciones e inicios de sesión relevantes.
- **RN-AUD-02** Cada registro incluye: **negocio**, **sucursal (cuando aplica)**, quién (usuario o "sistema"), fecha/hora del servidor, acción, entidad, valores **anteriores y nuevos**, motivo e IP.
- **RN-AUD-03** Solo-agregar: nadie edita ni borra la auditoría (reforzado en BD).
- **RN-AUD-04** Se escribe **en la misma transacción** que el cambio.
- **RN-AUD-05** Cada negocio consulta **solo su** auditoría. Las operaciones de plataforma (alta de negocio, soporte) van en una bitácora de plataforma aparte.

## 18. Fuera del alcance (la arquitectura lo prevé)

Facturación, suscripciones, planes, pagos y onboarding comercial · interfaz de administración de la plataforma · subdominios por negocio · QR / cámara / biometría · modo sin conexión · vacaciones, permisos e incapacidades · días festivos · horas extra y cualquier cálculo de nómina o pago · reglas tipo "N retardos = 1 falta" · notificaciones · PDF · rol de RH · módulos futuros (mesas, adelantos, nómina, comunicados, solicitudes).

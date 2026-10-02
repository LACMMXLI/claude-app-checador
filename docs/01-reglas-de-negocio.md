# 01 · Reglas de negocio — Reloj checador Fatboy

> Estado: **BORRADOR para validar**. Los valores marcados como `default` son propuestas mías y se pueden cambiar; los puntos que necesito que confirmes están en `docs/00-decisiones-pendientes.md` (referenciados como **[D-n]**).

## 1. Glosario

| Término | Significado |
|---|---|
| **Sucursal** | Local físico de Fatboy. Tiene zona horaria propia. |
| **Empleado** | Persona que checa. Se identifica con PIN. No tiene usuario/contraseña. |
| **Usuario** | Cuenta de acceso al panel web (administrador, encargado). Puede estar ligada a un empleado. |
| **Kiosco** | Tablet registrada y asignada a una sucursal. |
| **Turno programado** (`shift`) | Lo que *debería* trabajar un empleado: sucursal + hora de inicio + hora de fin. |
| **Jornada** (`attendance_record`) | Lo que *realmente* ocurrió para un turno: de la Entrada a la Salida, con sus cálculos. |
| **Checada** (`punch_event`) | Un evento individual: Entrada, Salida, Salida a comer, Regreso de comer. **Inmutable.** |
| **Corrección** | Registro que agrega, anula o ajusta una checada. Nunca edita la original. |
| **Incidencia** | Anomalía que requiere atención o justificación (olvido de checada, falta, etc.). |
| **Fecha laboral** (`business_date`) | Fecha *local* en que **inicia** el turno. Un turno 7 PM → 3 AM del 15 pertenece al día 14. |

## 2. Principios (no negociables)

1. **La jornada manda, no el día calendario.** Todo se agrupa por turno/jornada y fecha laboral, nunca por la fecha de la checada. Esto resuelve los turnos nocturnos.
2. **El servidor es la única fuente de hora.** La hora de una checada la pone el servidor, no la tablet.
3. **Las checadas son inmutables.** Se corrige agregando registros, nunca modificando ni borrando.
4. **Nada se borra físicamente** (empleados, sucursales, turnos, checadas): se desactiva o se cancela.
5. **Cero reglas quemadas:** tolerancias, tiempos y umbrales viven en configuración.
6. **Toda acción administrativa importante queda en auditoría** con quién, cuándo, antes y después.
7. **El servidor valida todo.** La pantalla del kiosco solo *muestra* lo permitido; quien lo *impone* es el backend.

## 3. Sucursales y asignaciones

- **RN-SUC-01** Cada sucursal tiene una zona horaria IANA (ej. `America/Mexico_City`) **[D-1]**. Todo se guarda en UTC y se interpreta en la zona de la sucursal.
- **RN-SUC-02** Todo empleado tiene **exactamente una asignación PRIMARIA vigente** (su sucursal base). Un cambio de sucursal base cierra la asignación anterior y abre otra: el historial se conserva.
- **RN-SUC-03** Un empleado puede tener **asignaciones TEMPORALES** a otras sucursales con rango de fechas (`desde`–`hasta`) y motivo.
- **RN-SUC-04** Un empleado solo puede checar en una sucursal donde tenga asignación vigente (primaria o temporal). La sucursal se determina por el **kiosco**, nunca por lo que mande el cliente.
- **RN-SUC-05** Solo se puede programar un turno en una sucursal donde el empleado tenga asignación vigente para esa fecha.
- **RN-SUC-06** Visibilidad: el administrador ve todas las sucursales. El encargado ve solo las sucursales de su rol: los empleados con asignación vigente en ellas y las jornadas ocurridas en ellas.
- **RN-SUC-07** Las jornadas guardan la sucursal **donde se trabajó**, no la base del empleado. Los reportes por sucursal usan ese dato.

## 4. Identificación en el kiosco (PIN)

- **RN-PIN-01** El PIN es numérico. Longitud configurable, `default` 6 dígitos, mínimo 4 **[D-8]**.
- **RN-PIN-02** El PIN es **único entre empleados activos** de toda la empresa (se identifica solo con el PIN, sin usuario).
- **RN-PIN-03** El PIN nunca se guarda en claro ni se puede consultar: solo se puede **generar uno nuevo** (se muestra una única vez al encargado/admin).
- **RN-PIN-04** Intentos fallidos: `default` 5 consecutivos en un kiosco ⇒ bloqueo de 60 s. Todos los intentos fallidos se registran.
- **RN-PIN-05** Mensaje de error genérico ("Código no válido") para no revelar si el PIN existe, está dado de baja o no tiene acceso a esa sucursal.
- **RN-PIN-06** Solo kioscos **registrados y activos** pueden recibir PINs. Un kiosco se registra desde el panel, queda ligado a una sucursal y su acceso se puede revocar.
- **RN-PIN-07** Tras identificarse, la sesión del empleado en el kiosco es corta: termina al completar la acción o tras `default` 20 s sin actividad, y regresa a la pantalla de código.
- **RN-PIN-08** Tras una checada exitosa se muestra confirmación (nombre, acción, hora del servidor) unos 4 s y se regresa a la pantalla inicial.

## 5. Checadas: eventos y máquina de estados

Cada jornada tiene un estado que determina qué acciones se ofrecen:

| Estado de la jornada | Acciones disponibles |
|---|---|
| Sin jornada abierta | **Entrada** |
| `TRABAJANDO` | **Salida**, **Salida a comer** |
| `EN_COMIDA` | **Regreso de comer** (solo esta) |

- **RN-EVT-01** El backend rechaza cualquier transición fuera de esa tabla. Las verificaciones y la inserción ocurren en **una transacción con bloqueo** de la jornada, de modo que dos toques simultáneos no puedan generar duplicados.
- **RN-EVT-02** **Antirrebote:** una checada del mismo empleado a menos de `default` 60 s de la anterior se rechaza ("ya registrado"). Además cada envío lleva un identificador de idempotencia: reintentos de red no duplican.
- **RN-EVT-03** Máximo de comidas por jornada: `default` 1 (configurable).
- **RN-EVT-04** Un empleado tiene **a lo más una jornada abierta** a la vez (garantizado por la base de datos).
- **RN-EVT-05** **Entrada ligada a turno:** al registrar Entrada se busca el turno programado del empleado en esa sucursal cuya ventana contenga la hora actual: desde `inicio − ventana_entrada_anticipada` (`default` 60 min) hasta el fin del turno **[D-5]**. Si hay varios, se toma el más cercano al inicio.
- **RN-EVT-06** **Sin turno programado:** `default` se permite la checada pero se marca con incidencia `SIN_TURNO` para que el encargado la revise; es configurable a "bloquear" **[D-6]**.
- **RN-EVT-07** **Turnos nocturnos:** la Salida (y Comida) se agregan a la **jornada abierta** del empleado sin importar que ya sea otro día calendario. La jornada conserva la fecha laboral de su Entrada.
- **RN-EVT-08** Estando `EN_COMIDA` no se permite Salida: primero debe registrar Regreso. Si olvidó el regreso, el tiempo de comida saldrá excesivo y quedará marcado para corrección (ver RN-INC).
- **RN-EVT-09** Una jornada abierta que supera `fin_de_turno + 240 min` (o `max_horas_jornada_sin_turno`, `default` 14 h si no tenía turno) se marca `REVISION`: deja de bloquear nuevas entradas y genera incidencia `SALIDA_FALTANTE` **[D-9]**.
- **RN-EVT-10** El kiosco no permite modificar ni cancelar una checada ya hecha.
- **RN-EVT-11** **Olvido de Entrada:** si el empleado olvidó checar al llegar, el kiosco solo le ofrecerá "Entrada" cuando quiera salir. Si esa Entrada cae después del fin de su turno programado, se registra pero se marca con `ENTRADA_FALTANTE`; el encargado la resuelve con una corrección (anula la entrada tardía y agrega las reales).

## 6. Horarios y turnos

- **RN-HOR-01** Un turno define empleado, sucursal, fecha laboral, hora local de inicio y hora local de fin. Si la hora de fin es **menor o igual** a la de inicio, el turno termina al día siguiente (ej. 19:00–03:00). El sistema calcula y guarda los instantes UTC exactos de inicio y fin.
- **RN-HOR-02** Duración válida de un turno: `default` entre 1 y 16 horas.
- **RN-HOR-03** Un empleado **no puede tener turnos traslapados** (restricción en base de datos). Sí puede tener más de un turno el mismo día (turno partido) mientras no se traslapen.
- **RN-HOR-04** **Programación semanal** por sucursal: la semana inicia en `default` lunes **[D-10]**. Estados: `BORRADOR` → `PUBLICADA`. El empleado solo ve horarios publicados.
- **RN-HOR-05** Se pueden definir **plantillas de turno** (ej. "Apertura 07:00–15:00", "Cierre 19:00–03:00") y **copiar la semana anterior** para agilizar la captura.
- **RN-HOR-06** Un día sin turno es **descanso**: no genera falta.
- **RN-HOR-07** Cambiar o cancelar un turno ya publicado requiere permiso, queda en auditoría con antes/después y motivo. Si el turno ya tiene jornada, esta se **recalcula** y también queda auditada. Los turnos pasados con jornada solo los modifica el administrador.
- **RN-HOR-08** Programan horarios: el administrador (todas las sucursales) y el encargado **solo si su rol incluye el permiso** `schedules.manage` para su sucursal.

## 7. Cálculo de asistencia

Variables: `Hp_ini` / `Hp_fin` = inicio/fin **programados**; `Hr_ini` / `Hr_fin` = primera Entrada / última Salida **reales**. Antes de comparar, los segundos se truncan (7:10:59 cuenta como 7:10).

| Resultado | Regla |
|---|---|
| **A tiempo** | `Hr_ini ≤ Hp_ini + tolerancia_entrada` |
| **Retardo** | `Hr_ini > Hp_ini + tolerancia_entrada`. Minutos de retardo = `Hr_ini − Hp_ini` completos **[D-3]** |
| **Falta** | No hubo Entrada cuando terminó el turno (la registra el sistema al cierre). Opcional: un retardo mayor a `retardo_cuenta_como_falta_min` (`default` apagado) cuenta como falta |
| **Salida anticipada** | `Hr_fin < Hp_fin − tolerancia_salida`. Solo si la Salida existe; si falta, es incidencia, no salida anticipada |
| **Horas programadas** | `Hp_fin − Hp_ini` |
| **Horas trabajadas** | `Hr_fin − Hr_ini` (tiempo entre la Entrada y la Salida). **No se descuenta la comida** |
| **Tiempo de comida** | Suma de (`Regreso − Salida a comer`). Dato informativo, independiente de las horas trabajadas |
| **Exceso de comida** | `max(0, Tiempo de comida − comida_permitida_min − tolerancia_comida_min)` |

- **RN-CAL-01** La entrada anticipada se registra con la hora real. Las horas trabajadas usan hora real; el reporte muestra también la diferencia contra lo programado.
- **RN-CAL-02** **La comida es solo control de tiempo e incidencias:** registra a qué hora salió, a qué hora regresó y cuánto tiempo estuvo fuera. **No descuenta tiempo de las horas trabajadas, no calcula pagos y no afecta nómina** (ni tiene relación con el costo de los alimentos). Si el empleado tiene 30 min permitidos y tarda 42, el sistema registra duración 42 min y exceso 12 min, y genera la incidencia `COMIDA_EXCEDIDA`. Por `default`: 35 min permitidos y 0 min de tolerancia (ambos configurables por sucursal o empleado).
- **RN-CAL-03** Comida con salida pero sin regreso ⇒ incidencia `REGRESO_COMIDA_FALTANTE`.
- **RN-CAL-04** Opcional: `requiere_comida` (`default` apagado). Si está activo y la jornada no tiene comida ⇒ incidencia `SIN_COMIDA`.
- **RN-CAL-05** **Los resultados se calculan con la política vigente y se guardan con una copia de los parámetros usados.** Cambiar una tolerancia hoy **no modifica silenciosamente** resultados históricos; solo se recalcula una jornada cuando hay corrección o un reproceso explícito (que queda auditado).
- **RN-CAL-06** Los cálculos viven en una función pura (entradas: checadas efectivas + turno + política ⇒ salida: resultado), con pruebas automáticas que incluyan turnos nocturnos y cambios de zona horaria.

## 8. Configuración (sin reglas en código)

- **RN-CFG-01** Las políticas se resuelven en cascada: **Empleado > Sucursal > Global**. Lo no definido hereda del nivel superior; el nivel global siempre está completo.
- **RN-CFG-02** Todo cambio de configuración es auditado y surte efecto **hacia adelante** (ver RN-CAL-05).
- **RN-CFG-03** Parámetros iniciales:

| Parámetro | Default |
|---|---|
| `tolerancia_entrada_min` | 10 |
| `tolerancia_salida_min` | 0 |
| `retardo_cuenta_como_falta_min` | apagado |
| `umbral_no_se_presento_min` (tablero en vivo) | 60 **[D-4]** |
| `ventana_entrada_anticipada_min` | 60 |
| `comida_permitida_min` | 35 |
| `tolerancia_comida_min` | 0 |
| `max_comidas_por_jornada` | 1 |
| `requiere_comida` | no |
| `checada_sin_turno` | permitir y marcar |
| `antirrebote_seg` | 60 |
| `salida_faltante_tras_min` | 240 |
| `max_horas_jornada_sin_turno` | 14 |
| `pin_longitud` | 6 |
| `pin_intentos_max` / `pin_bloqueo_seg` | 5 / 60 |
| `kiosco_inactividad_seg` | 20 |
| `inicio_de_semana` | lunes |

## 9. Incidencias

- **RN-INC-01** Tipos iniciales: `SALIDA_FALTANTE`, `ENTRADA_FALTANTE` (la "Entrada" se registró después de que terminó su turno: probable olvido de la entrada real), `REGRESO_COMIDA_FALTANTE`, `SALIDA_COMIDA_FALTANTE`, `COMIDA_EXCEDIDA`, `RETARDO`, `FALTA`, `SALIDA_ANTICIPADA`, `SIN_TURNO`, `SIN_COMIDA`.
- **RN-INC-02** Las incidencias las **genera el sistema** (al checar o por un proceso que corre cada minuto). El empleado nunca las crea ni las edita.
- **RN-INC-03** Ciclo de vida: `ABIERTA` → `RESUELTA` con una resolución: `CORREGIDA` (se aplicó una corrección), `JUSTIFICADA` (se acepta la causa y no cuenta en contra), `CONFIRMADA` (procede tal cual) o `DESCARTADA` (generada por error). Siempre con motivo, usuario y fecha.
- **RN-INC-04** Los reportes de retardos/faltas distinguen **confirmados** de **justificados**.
- **RN-INC-05** El empleado puede consultar (solo lectura) sus incidencias desde el kiosco.

## 10. Correcciones

- **RN-COR-01** El empleado **no** puede corregir nada.
- **RN-COR-02** Una corrección puede: **agregar** una checada faltante, **anular** una checada errónea o **cambiar la hora** (= anular + agregar, en una sola operación). Siempre con **motivo obligatorio**.
- **RN-COR-03** La checada original se conserva intacta. Se guarda: original, corrección, quién, cuándo, motivo y, si aplica, quién la aprobó.
- **RN-COR-04** Dos permisos distintos: `attendance.correction.request` (solicita; requiere aprobación) y `attendance.correction.apply` (aplica directamente). El administrador tiene ambos; el encargado, `default`, aplica directo dentro de su sucursal con motivo obligatorio **[D-7]**. Es un cambio de permisos, no de código.
- **RN-COR-05** Al aplicarse una corrección, la jornada se recalcula y la incidencia relacionada se marca `CORREGIDA`.
- **RN-COR-06** Una corrección no puede dejar la secuencia ilógica (ej. Salida antes de Entrada, comida fuera de la jornada). El sistema valida la secuencia resultante antes de aplicarla.

## 11. Empleados

- **RN-EMP-01** Nunca se borra un empleado. Estados: `ACTIVO` / `INACTIVO` (baja), con fecha y motivo de baja.
- **RN-EMP-02** Al dar de baja: se invalida su PIN, desaparece de la programación futura (turnos futuros se cancelan con auditoría) y su historial queda intacto.
- **RN-EMP-03** Una baja se puede revertir (reingreso): se reactiva el mismo registro con nuevo PIN y nueva asignación primaria.
- **RN-EMP-04** Tras la baja, el PIN puede reasignarse a otro empleado sin afectar el historial (el historial referencia al empleado, no al PIN).

## 12. Roles y permisos

Modelo: **roles con permisos granulares** y cada asignación de rol a un usuario tiene **alcance**: *todas las sucursales* o *una sucursal concreta*. Permite crear después RH u otros roles sin tocar código.

| Capacidad | Empleado (kiosco) | Encargado | Administrador |
|---|:-:|:-:|:-:|
| Checar | ✅ | ✅ (es empleado) | ✅ |
| Ver sus propias asistencias, horarios e incidencias | ✅ | ✅ | ✅ |
| Ver empleados de su sucursal | — | ✅ | ✅ (todas) |
| Asistencia del día / quién trabaja ahora | — | ✅ | ✅ |
| Ver retardos, faltas y comidas | — | ✅ | ✅ |
| Resolver incidencias | — | ✅ | ✅ |
| Aplicar o solicitar correcciones | — | ✅ (según permiso) | ✅ |
| Programar horarios | — | solo con permiso | ✅ |
| Alta/baja/edición de empleados, PIN, asignaciones | — | ⚙️ opcional por permiso | ✅ |
| Sucursales, kioscos, configuración, roles | — | — | ✅ |
| Reportes y exportación | — | su sucursal | ✅ |
| Consultar auditoría | — | — | ✅ |

- **RN-ROL-01** El empleado **no tiene cuenta web**: sus consultas se hacen en el kiosco tras ingresar su PIN. (Acceso desde su celular queda como mejora futura.)
- **RN-ROL-02** Encargados y administradores entran al panel con **usuario y contraseña** **[D-11]**.
- **RN-ROL-03** Un cambio de rol, permiso o alcance se audita.
- **RN-ROL-04** Siempre debe existir al menos un administrador activo.

## 13. Tablero en tiempo real

Por sucursal, lista cada empleado con turno programado "ahora" o con jornada abierta:

| Estado mostrado | Cuándo |
|---|---|
| **Trabajando** | Jornada `TRABAJANDO` |
| **En comida** (con minutos transcurridos; en rojo si excede) | Jornada `EN_COMIDA` |
| **Por llegar** | Turno inicia pronto o ya inició y aún está dentro de la tolerancia |
| **Retardo** | Sin Entrada y ya pasó `tolerancia_entrada` |
| **No se presentó** | Sin Entrada y ya pasó `umbral_no_se_presento_min` |
| **Salió** | Jornada cerrada hoy |
| **Revisión** | Jornada con incidencia abierta de checada faltante |

- **RN-RT-01** El tablero incluye turnos nocturnos que iniciaron "ayer" y siguen abiertos (se consulta por jornada abierta y por ventana de turno, no por fecha calendario).
- **RN-RT-02** Se actualiza en tiempo casi real (≤ 2 s tras una checada). Los estados que cambian solo por el paso del tiempo (Retardo, No se presentó, comida excedida) se refrescan cada ~30 s.
- **RN-RT-03** Cada encargado solo recibe las actualizaciones de sus sucursales.

## 14. Reportes y exportación

- **RN-REP-01** Filtros: empleado, sucursal, día, semana, periodo personalizado. Siempre por **fecha laboral**.
- **RN-REP-02** Métricas por jornada y agregadas: horas programadas, horas trabajadas, retardos (y minutos), faltas, tiempo de comida y excesos, salidas anticipadas, incidencias (abiertas/justificadas) y correcciones.
- **RN-REP-03** Las jornadas corregidas se identifican visiblemente (con acceso al antes/después).
- **RN-REP-04** Exportación a **Excel** (MVP) y **PDF** (después). Quién exporta y qué filtros usó se registra en auditoría.
- **RN-REP-05** El rango del reporte se respeta en zona horaria de la sucursal.

## 15. Auditoría

- **RN-AUD-01** Se audita como mínimo: alta/edición/baja de empleados, cambio de sucursal o asignación, creación/cambio/cancelación/publicación de turnos, correcciones y resolución de incidencias, cambios de roles/permisos, cambios de configuración, alta/revocación de kioscos, reinicio de PIN, reprocesos y exportaciones.
- **RN-AUD-02** Cada registro incluye: quién (o "sistema"), fecha/hora del servidor, acción, entidad afectada, sucursal, valores **anteriores y nuevos**, motivo (si aplica) e IP.
- **RN-AUD-03** La auditoría es **solo-agregar**: ni la aplicación ni nadie con acceso normal puede editar o borrar sus registros (se refuerza en la base de datos).
- **RN-AUD-04** La bitácora se escribe **en la misma transacción** que el cambio: no puede existir un cambio sin su registro.
- **RN-AUD-05** El administrador puede consultar la auditoría filtrando por usuario, entidad, sucursal y rango de fechas.

## 16. Fuera del alcance del MVP (pero la arquitectura lo prevé)

QR / cámara / biometría · modo sin conexión en el kiosco · vacaciones, permisos e incapacidades · días festivos · horas extra, descuentos y cualquier cálculo de nómina o pago (incluida la comida) · reglas tipo "N retardos = 1 falta" · notificaciones (WhatsApp/correo) · exportación PDF · rol de RH · módulos futuros (mesas, adelantos, nómina, comunicados, solicitudes).

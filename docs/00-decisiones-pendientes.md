# 00 · Decisiones pendientes

Para cada punto dejo mi **propuesta** (`default`). Si estás de acuerdo con todas, basta responder "ok a los defaults". Si cambias alguna, dime el número.

| # | Pregunta | Propuesta | Impacto |
|---|---|---|---|
| **D-1** | ¿En qué zona horaria están las 3 sucursales? ¿Todas la misma? | `America/Mexico_City` para todas, configurable por sucursal. | Cálculo de turnos y fechas laborales |
| **D-2** | ¿La comida **se paga** (cuenta como tiempo trabajado) o **se descuenta**? | Se descuenta (horas trabajadas = presencia − comida). | Horas trabajadas en reportes |
| **D-3** | Si la tolerancia es 10 min y llega a las 7:12 para un turno de 7:00, ¿el retardo es de **12 min** o de **2 min**? (Y a las 7:09, ¿es a tiempo?) | 12 min (se cuenta desde la hora programada); a las 7:09 es a tiempo. | Minutos de retardo |
| **D-4** | ¿Después de cuántos minutos sin llegar se considera **"no se presentó"** en el tablero? ¿Un retardo muy grande cuenta como falta? | 60 min para mostrarlo en el tablero. El retardo grande **no** se convierte en falta (configurable). La falta definitiva se registra al terminar el turno. | Tablero y reportes de faltas |
| **D-5** | ¿Cuánto antes del turno se permite checar entrada? ¿El tiempo antes de la hora programada cuenta como trabajado? | 60 min antes. Cuenta hora real (se muestra la diferencia con lo programado). | Entradas anticipadas, horas |
| **D-6** | Si alguien checa **sin tener turno programado** (cubrió a alguien, se olvidaron de programarlo): ¿se **permite y se marca** o se **bloquea**? | Permitir y marcar con incidencia `SIN_TURNO`. | Operación diaria |
| **D-7** | ¿El encargado **aplica** correcciones directamente (con motivo obligatorio) o solo **solicita** y el admin aprueba? | Aplica directo en su sucursal con motivo; todo auditado; el admin puede revisarlo. (Es un permiso: se cambia sin código.) | Agilidad vs control |
| **D-8** | Longitud del PIN y quién lo asigna. ¿El empleado puede cambiarlo? | 6 dígitos, generado por el sistema, lo entrega el encargado/admin. Cambio por el empleado: fase futura. | Seguridad / UX |
| **D-9** | "**Hora límite de operación**": lo entendí como el momento a partir del cual una jornada abierta sin salida se considera olvidada. ¿Es eso, o te referías al horario de apertura/cierre del local (para no permitir checadas fuera de él)? | Mi interpretación: 4 h después del fin del turno se marca "revisión". Si además quieres horario de operación por sucursal, lo agrego. | Detección de olvidos |
| **D-10** | ¿La semana de programación inicia lunes? ¿Hay periodos de pago (quincenal/semanal) que deban existir en reportes? | Semana lunes–domingo; periodo personalizado libre. | Programación y reportes |
| **D-11** | ¿Encargados y administradores entran con **correo + contraseña** al panel? | Sí. 2FA opcional más adelante. | Acceso al panel |
| **D-12** | ¿Qué tan estable es el internet en las sucursales? ¿Necesitas que el kiosco **funcione sin conexión**? | MVP requiere conexión; contingencia manual. Offline como fase futura. | Complejidad del kiosco |
| **D-13** | ORM: **Drizzle** o **Prisma**. | Drizzle (por triggers/restricciones de Postgres). | Código de acceso a datos |
| **D-14** | ¿Más de una comida o descanso por jornada? | Una comida (configurable). | Máquina de estados |
| **D-15** | ¿Te sirve que el **encargado también sea empleado** (checa y además administra)? ¿Los dueños/administradores checan? | Sí: un usuario puede estar ligado a un empleado. | Modelo de usuarios |
| **D-16** | Idioma: **interfaz y documentos en español**, código/nombres de tablas en inglés. | Sí. | Convenciones |

## Siguiente paso

1. Revisas/ajustas `01-reglas-de-negocio.md` y estas decisiones.
2. Con tus respuestas congelo reglas y modelo.
3. Empiezo **Fase 0** (monorepo, Docker, CI, migraciones, auth, auditoría) y la subimos a Coolify desde el principio para validar el despliegue.

# 00 · Registro de decisiones

Todas las decisiones funcionales actuales están **cerradas** (reglas v1.0 y modelo v1.0 congelados). Un cambio posterior se anota aquí con fecha y motivo.

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

## Aclaraciones de la Fase 1 (sin reabrir reglas funcionales)

- **Sesión:** cookie `HttpOnly` + `SameSite=Lax` + expiración (12 h); en producción `Secure` y prefijo `__Host-`. Nunca `localStorage`. Se **rota** el identificador al iniciar sesión y al cambiar de negocio; logout la revoca en el servidor.
- **Identidad ≠ negocio activo:** `login → identidad → membresías → negocio activo (en la sesión, validado por el servidor) → TenantDb`. Una membresía inactiva o un negocio suspendido quitan el negocio activo de las sesiones vivas; una identidad deshabilitada invalida todas sus sesiones.
- **Invitaciones (D-11):** el admin invita un correo con rol y alcance; el token (256 bits, guardado hasheado, uso único, 72 h) se muestra una vez al admin. Identidad nueva: el invitado elige su contraseña. Identidad existente: prueba su contraseña ACTUAL y solo se agrega la membresía (nunca se cambia su contraseña).
- **ENCARGADO** incluye por defecto `employees.manage` y `employees.pin.manage`, siempre limitados a su alcance de sucursales (RN-COR/RN-ROL: "opcional por permiso" → cada negocio puede quitarlo).
- **Kioscos:** el dispositivo (activo/inactivo) y su token (generar/revocar/regenerar) son cosas separadas.

## Criterios obligatorios ANTES de considerar el sistema desplegable

- [ ] `Dockerfile` (api y web) construidos y `docker compose up` sobre una base limpia: migraciones, pruebas completas y API/panel arriba. *(No verificado aún: el entorno de desarrollo no tiene Docker.)*
- [ ] Una ejecución **real** de GitHub Actions en verde sobre PostgreSQL real (typecheck, build, migraciones desde cero, `check:tenancy`, pruebas, E2E, smoke).

## Ajustes por el congelamiento (respecto al borrador anterior)

- Se **eliminó** `retardo_cuenta_como_falta_min` (contradice D-4).
- `operational_cutoff` pasó de columna de sucursal a **parámetro de política heredable** (D-20).
- La política **de plataforma** (valores por defecto) vive en `platform.policy_defaults`; el nivel Negocio ya no necesita estar completo.
- `INACTIVE`/`ACTIVE`, `WORKING`/`ON_BREAK`/`REVIEW` y demás enums en inglés (D-16).

## Fuera de la Fase 0 (se aborda después)

Alta de usuarios/invitaciones por el administrador del negocio, recuperación de contraseña por correo, login HTTP, UI. Ver `03-arquitectura.md §10`.

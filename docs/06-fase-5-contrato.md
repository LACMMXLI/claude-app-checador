# Fase 5 · Plataforma de suscripciones (consola del SaaS)

Contrato de la fase. Decisiones **D-81 … D-90** (se resumen también en `00-decisiones.md`).
Alcance: administrar **clientes (negocios)**, **planes** y **suscripciones** del SaaS. **Sin pagos**: no hay medios de pago,
cobros, facturas ni pasarelas; la vigencia la fija a mano un operador.

## Piezas

| Pieza | Qué es | Quién la usa |
|---|---|---|
| `apps/platform-api` | API (NestJS) del **plano de plataforma**. Usa el rol `platform_ops`. | Solo la consola |
| `apps/platform-web` | Consola (Next.js) con proxy `/api` hacia `platform-api`. | Operadores de la plataforma |
| `apps/api` (existente) | API de los **clientes**; sigue usando solo `app_user`. Ahora aplica el plan del negocio. | Panel y kiosco |
| Migración `0013` | Planes, suscripciones, operadores, historial y límites en PostgreSQL. | — |

Los dos planos están separados: contenedores, dominios, cookies, credenciales de BD y personas distintos.
La API de clientes **no** conoce `platform_ops` (lo vigila `test/architecture.test.ts`).

## Decisiones

- **D-81 · Dos planos.** La consola vive en `apps/platform-api` + `apps/platform-web`, con su propio dominio. Los operadores
  **no** son usuarios de ningún negocio y los usuarios de un negocio no entran a la consola. La API de plataforma reutiliza
  el servicio de alta de negocios existente (`PlatformAdminService`) para no duplicar el aprovisionamiento.
- **D-82 · Operadores.** Identidad propia (`platform.operators`, contraseña argon2id, bloqueo progresivo tras 5 fallos como en los
  negocios). Sesión en cookie `HttpOnly` (`__Host-psid` en producción), 8 h, hash SHA-256 en BD, defensa CSRF con
  `X-Requested-With: platform`. Rol único (todos pueden todo). El primer operador se crea por CLI; después, desde la consola.
  Un operador no puede deshabilitarse a sí mismo ni dejar la plataforma sin operadores activos.
- **D-83 · Planes.** Tabla `platform.plans`: límites de **sucursales, empleados activos, kioscos activos y usuarios activos**
  (`NULL` = sin límite) y **funciones** (`reportsExport`: exportar reportes a XLSX/CSV; `scheduleTemplates`: plantillas de
  horario). Dos planes semilla, editables por un operador:
  - **BASIC** — 2 sucursales · 25 empleados · 2 kioscos · 3 usuarios · sin exportación ni plantillas.
  - **ADVANCED** — 10 sucursales · 250 empleados · 20 kioscos · 25 usuarios · todas las funciones.
  Un plan inactivo no se puede asignar a negocios nuevos; los que ya lo tienen lo conservan.
- **D-84 · Suscripción sin cobros.** Una suscripción vigente por negocio (`platform.subscriptions`): plan + estado
  `TRIAL | ACTIVE | SUSPENDED | EXPIRED | CANCELLED` + vigencia manual (`trial_ends_at` en prueba, `current_period_end`
  en activa; `NULL` = sin vencimiento) + notas internas. `TRIAL` y `ACTIVE` dejan operar al negocio; los demás lo
  **suspenden** (`core.organizations.status = 'SUSPENDED'`, que ya bloquea inicio de sesión, sesiones vivas, kioscos e
  invitaciones). La sincronización la hace un **trigger** en la misma transacción. Un barrido periódico de la
  API de plataforma pasa a `EXPIRED` las suscripciones vencidas. **Nada se borra**: suspender o cancelar conserva todos los datos.
- **D-85 · Historial inmutable.** `platform.subscription_events` (solo-agregar) lo escribe un trigger por cada cambio de plan,
  estado, vigencia o notas, con el operador responsable (`app.platform_actor`). Además, cada acción de operador queda en
  `platform.platform_audit_log`.
- **D-86 · Límites en capas.** (1) Un trigger de PostgreSQL exige el cupo de sucursales, empleados, kioscos y usuarios activos para
  el tráfico de `app_user` y responde `PLAN_LIMIT_*` (también cuando se acepta una invitación, que no pasa por el servicio);
  los operadores de plataforma pueden exceder por decisión operativa. (2) El servicio de invitaciones verifica el cupo de usuarios
  (activos + invitaciones pendientes) al invitar y devuelve el límite y el uso. (3) Las funciones del plan
  (`FEATURE_NOT_IN_PLAN`) se verifican en el servicio. Solo cuentan los registros **activos**; desactivar
  libera cupo. **Bajar de plan nunca borra ni desactiva datos**: solo se impide crear/reactivar por encima del nuevo límite.
- **D-87 · El cliente ve su plan.** `GET /api/subscription` (solo lectura: plan, estado, vigencia, límites y uso) y la pestaña
  **Configuración → Plan**. Las notas internas y los datos de otros negocios nunca salen de la plataforma.
- **D-88 · Alta de cliente desde la consola.** Crea negocio + sucursales + primer administrador + suscripción en una sola
  transacción. La contraseña inicial del administrador se **genera** (o la escribe el operador), se muestra **una vez** y
  nunca se registra. El operador puede restablecer la contraseña global de una persona (queda en la bitácora, sin la contraseña).
- **D-89 · Compatibilidad.** Los negocios existentes pasan a `ADVANCED/ACTIVE` sin vencimiento. Un negocio creado fuera de la
  consola (CLI, pruebas) recibe automáticamente `ADVANCED/ACTIVE` (trigger), así que **todo negocio tiene siempre una suscripción**.
- **D-90 · Sin recuperación por correo.** Igual que en los negocios, el restablecimiento de contraseñas de operadores es por CLI
  (`platform-admin reset-operator-password`) mientras no exista un servicio de correo.

## Estados de la suscripción (transiciones permitidas desde la consola)

```
 (alta) ─► TRIAL ──(vence)──► EXPIRED ──activar──► ACTIVE ──(vence)──► EXPIRED
             │                                       ▲
             └──────── suspender (TRIAL/ACTIVE/EXPIRED) ─► SUSPENDED ──activar──┘
 cualquier estado ──cancelar──► CANCELLED ──activar──► ACTIVE
 (cualquier estado) ──iniciar prueba──► TRIAL
```

Acciones de la consola: **cambiar plan** (no cambia el estado), **activar/renovar** (ACTIVE con vigencia futura o sin vencimiento),
**iniciar prueba** (TRIAL de 1–90 días), **extender** (solo TRIAL o ACTIVE), **suspender** y **cancelar** (con motivo) y **notas internas**.
- Reanudar un negocio suspendido, vencido o cancelado es **activar**.
- La consola muestra el estado **efectivo**; la verdad está en PostgreSQL.

## Fuera de alcance (otra fase)

Cobros/pasarelas, facturación, correos, autoservicio de alta por parte del cliente, roles distintos de operador,
recuperación de contraseña por correo, métricas históricas de uso.

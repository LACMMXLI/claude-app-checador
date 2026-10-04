# Sistema de empleados — módulo Reloj Checador (plataforma multi-negocio)

Plataforma para control de asistencia de negocios con varias sucursales: kiosco con PIN, horarios rotativos, turnos nocturnos, incidencias, correcciones auditadas, tablero en tiempo real y reportes. **Multi-tenant desde el inicio** (Plataforma → Negocio → Sucursales → Empleados) y primer módulo de un sistema de empleados más amplio. **Fatboy es el primer negocio (tenant).**

**Estado:** reglas y modelo v1.5 **congelados** · **Fase 0** (fundaciones multi-tenant), **Fase 1** (identidad, sesión, negocio activo, RBAC y panel base), **Fase 2** (horarios y turnos concretos), **Fase 3** (asistencia: kiosco, jornadas, pausas, incidencias, reconciliación y correcciones) **Fase 4** (solicitudes de corrección con aprobación, reportes y exportación XLSX/CSV, tiempo real por SSE, control de kioscos, faltas anuladas, salida anticipada, sin comida y pausa omitida) y **Fase 5** (consola de plataforma: clientes, planes Básico/Avanzado y suscripciones sin cobros, con límites aplicados en la app de clientes) implementadas y probadas. CI en GitHub Actions en verde. La validación con Docker/Coolify se hace en el servidor de producción.

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/00-decisiones.md`](docs/00-decisiones.md) | Registro de decisiones (D-1 … D-90) |
| [`docs/01-reglas-de-negocio.md`](docs/01-reglas-de-negocio.md) | Reglas de negocio v1.5 (RN-xxx) |
| [`docs/02-modelo-de-datos.md`](docs/02-modelo-de-datos.md) | Modelo PostgreSQL v1.5, aislamiento por negocio (RLS) |
| [`docs/03-arquitectura.md`](docs/03-arquitectura.md) | Arquitectura v1.5, seguridad, despliegue, tiempo real, fases |
| [`docs/04-operacion.md`](docs/04-operacion.md) | Operación: desarrollo, despliegue en Coolify, checklist de tablas nuevas |
| [`docs/05-fase-4-contrato.md`](docs/05-fase-4-contrato.md) | Contrato aprobado de la Fase 4 (solicitudes, reportes, SSE, kioscos) |
| [`docs/06-fase-5-contrato.md`](docs/06-fase-5-contrato.md) | Contrato de la Fase 5 (consola de plataforma, planes y suscripciones) |

## Stack

TypeScript · NestJS · Next.js · PostgreSQL 16 (RLS) · Drizzle ORM + migraciones SQL · Zod · Vitest · Playwright · Docker Compose · Coolify.

## Comandos

```bash
pnpm install
pnpm typecheck && pnpm build
pnpm test              # pruebas contra PostgreSQL real: API de clientes (aislamiento, RLS, PIN, kioscos, planes...) y API de plataforma
pnpm check:tenancy     # lo que ejecuta CI: toda tabla multi-tenant debe estar protegida
./scripts/e2e.sh       # E2E del panel y del kiosco contra API y PostgreSQL reales
./scripts/e2e-platform.sh   # E2E de la consola de plataforma (clientes, planes, suscripciones)
pnpm --filter @checador/api reconcile   # reconciliación de asistencia (idempotente)
# valores de política de un negocio sin tocar código (p. ej. Fatboy, Fase 4):
node apps/api/dist/src/cli/platform.js set-policy --slug fatboy --param breakRequiredAfterMin=360 --param exitToleranceMin=5
```

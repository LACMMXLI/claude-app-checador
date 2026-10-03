# Sistema de empleados — módulo Reloj Checador (plataforma multi-negocio)

Plataforma para control de asistencia de negocios con varias sucursales: kiosco con PIN, horarios rotativos, turnos nocturnos, incidencias, correcciones auditadas, tablero en tiempo real y reportes. **Multi-tenant desde el inicio** (Plataforma → Negocio → Sucursales → Empleados) y primer módulo de un sistema de empleados más amplio. **Fatboy es el primer negocio (tenant).**

**Estado:** reglas y modelo v1.3 **congelados** · **Fase 0** (fundaciones multi-tenant), **Fase 1** (identidad, sesión, negocio activo, RBAC y panel base), **Fase 2** (horarios y turnos concretos) y **Fase 3** (asistencia: kiosco, jornadas, pausas, incidencias, reconciliación y correcciones) implementadas y probadas. CI en GitHub Actions en verde. La validación con Docker/Coolify se hace en el servidor de producción.

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/00-decisiones.md`](docs/00-decisiones.md) | Registro de decisiones (D-1 … D-77) |
| [`docs/01-reglas-de-negocio.md`](docs/01-reglas-de-negocio.md) | Reglas de negocio v1.3 (RN-xxx) |
| [`docs/02-modelo-de-datos.md`](docs/02-modelo-de-datos.md) | Modelo PostgreSQL v1.3, aislamiento por negocio (RLS) |
| [`docs/03-arquitectura.md`](docs/03-arquitectura.md) | Arquitectura v1.3, seguridad, despliegue, fases |
| [`docs/04-operacion.md`](docs/04-operacion.md) | Operación: desarrollo, despliegue en Coolify, checklist de tablas nuevas |
| [`docs/05-fase-4-contrato.md`](docs/05-fase-4-contrato.md) | Contrato aprobado de la Fase 4 (solicitudes, reportes, SSE, kioscos) |

## Stack

TypeScript · NestJS · Next.js · PostgreSQL 16 (RLS) · Drizzle ORM + migraciones SQL · Zod · Vitest · Playwright · Docker Compose · Coolify.

## Comandos

```bash
pnpm install
pnpm typecheck && pnpm build
pnpm test              # pruebas contra PostgreSQL real (aislamiento, RLS, PIN, kioscos, políticas...)
pnpm check:tenancy     # lo que ejecuta CI: toda tabla multi-tenant debe estar protegida
./scripts/e2e.sh       # E2E del panel y del kiosco contra API y PostgreSQL reales
pnpm --filter @checador/api reconcile   # reconciliación de asistencia (idempotente)
```

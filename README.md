# Sistema de empleados — módulo Reloj Checador (plataforma multi-negocio)

Plataforma para control de asistencia de negocios con varias sucursales: kiosco con PIN, horarios rotativos, turnos nocturnos, incidencias, correcciones auditadas, tablero en tiempo real y reportes. Diseñada como **multi-tenant** desde el inicio (Plataforma → Negocio → Sucursales → Empleados) y como el primer módulo de un sistema de empleados más amplio. **Fatboy es el primer negocio (tenant).**

**Estado:** fase de diseño (aún sin código).

## Documentación de diseño

| Documento | Contenido |
|---|---|
| [`docs/00-decisiones-pendientes.md`](docs/00-decisiones-pendientes.md) | Decisiones resueltas y pendientes |
| [`docs/01-reglas-de-negocio.md`](docs/01-reglas-de-negocio.md) | Reglas de negocio numeradas (RN-xxx) |
| [`docs/02-modelo-de-datos.md`](docs/02-modelo-de-datos.md) | Modelo PostgreSQL, aislamiento por negocio (RLS) y casos difíciles |
| [`docs/03-arquitectura.md`](docs/03-arquitectura.md) | Stack, multi-tenancy, seguridad, despliegue en Coolify y fases |

## Stack propuesto

TypeScript · Next.js (kiosco + panel) · NestJS (API) · PostgreSQL con RLS · Drizzle · Docker Compose · Coolify.

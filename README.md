# Fatboy · Sistema de empleados — módulo Reloj Checador

Sistema para control de asistencia de las sucursales de Fatboy (kiosco con PIN, horarios rotativos, turnos nocturnos, incidencias, correcciones auditadas, tablero en tiempo real y reportes). Diseñado como el primer módulo de un sistema de empleados más amplio.

**Estado:** fase de diseño (aún sin código).

## Documentación de diseño

| Documento | Contenido |
|---|---|
| [`docs/00-decisiones-pendientes.md`](docs/00-decisiones-pendientes.md) | Preguntas abiertas con propuesta por defecto |
| [`docs/01-reglas-de-negocio.md`](docs/01-reglas-de-negocio.md) | Reglas de negocio numeradas (RN-xxx) |
| [`docs/02-modelo-de-datos.md`](docs/02-modelo-de-datos.md) | Modelo PostgreSQL, restricciones y casos difíciles |
| [`docs/03-arquitectura.md`](docs/03-arquitectura.md) | Stack, módulos, seguridad, despliegue en Coolify y fases |

## Stack propuesto

TypeScript · Next.js (kiosco + panel) · NestJS (API) · PostgreSQL · Drizzle · Docker Compose · Coolify.

# syntax=docker/dockerfile:1
# Consola de plataforma (Next.js). Contexto de build: la RAÍZ del repositorio.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/platform-web/package.json apps/platform-web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @checador/platform-web...
COPY apps/platform-web apps/platform-web
RUN pnpm --filter @checador/platform-web build

FROM node:22-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3002 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/platform-web/.next/standalone ./
COPY --from=build /repo/apps/platform-web/.next/static ./apps/platform-web/.next/static
USER node
EXPOSE 3002
# PLATFORM_API_INTERNAL_URL (p. ej. http://platform-api:3100) se lee en tiempo de ejecución por el proxy /api
CMD ["node", "apps/platform-web/server.js"]

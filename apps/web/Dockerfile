# syntax=docker/dockerfile:1
# Contexto de build: la RAÍZ del repositorio.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @checador/web...
COPY apps/web apps/web
RUN pnpm --filter @checador/web build

FROM node:22-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3001 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
# imágenes de marca (public/brand): el modo standalone no las copia solo
COPY --from=build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3001
# API_INTERNAL_URL (p. ej. http://api:3000) se lee en tiempo de ejecución por el proxy /api
CMD ["node", "apps/web/server.js"]

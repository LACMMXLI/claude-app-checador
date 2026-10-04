# syntax=docker/dockerfile:1
# API de la consola de plataforma. Contexto de build: la RAÍZ del repositorio (ver docker-compose.yml).
# Depende del paquete @checador/api (aprovisionamiento, esquema y utilidades compartidas) por su punto de entrada público.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/platform-api/package.json apps/platform-api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @checador/platform-api...

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY apps/platform-api apps/platform-api
# compila primero @checador/api (dependencia) y luego la API de plataforma
RUN pnpm --filter @checador/platform-api... build

FROM base AS prod-deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/platform-api/package.json apps/platform-api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter @checador/platform-api...

FROM node:22-slim AS runtime
ENV NODE_ENV=production TZ=UTC
WORKDIR /repo/apps/platform-api
COPY --from=prod-deps /repo/node_modules /repo/node_modules
COPY --from=prod-deps /repo/apps/api/node_modules /repo/apps/api/node_modules
COPY --from=prod-deps /repo/apps/platform-api/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist /repo/apps/api/dist
COPY apps/api/package.json /repo/apps/api/
COPY --from=build /repo/apps/platform-api/dist ./dist
COPY apps/platform-api/package.json ./
USER node
EXPOSE 3100
CMD ["node", "dist/src/main.js"]

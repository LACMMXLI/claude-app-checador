#!/usr/bin/env bash
# E2E del panel contra PostgreSQL real: base limpia → roles → migraciones → negocio Fatboy → API → web → Playwright.
# Requiere: PostgreSQL accesible con superusuario y `pnpm build` previo.
#   E2E_PG_SUPER_URL (default postgresql://postgres:postgres@127.0.0.1:5432/postgres)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPER_URL="${E2E_PG_SUPER_URL:-postgresql://postgres:postgres@127.0.0.1:5432/postgres}"
DB=checador_e2e
BASE="${SUPER_URL%/*}"
HOSTPART="${BASE#*@}"

if curl -fs -o /dev/null http://127.0.0.1:3901/login || curl -fs -o /dev/null http://127.0.0.1:3900/health; then echo 'Puertos 3900/3901 ocupados por otro proceso' >&2; exit 1; fi
psql "$SUPER_URL" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
# Los roles son de todo el clúster: se respetan las contraseñas ya definidas en el entorno (CI)
export MIGRATOR_PASSWORD="${MIGRATOR_PASSWORD:-e2e_m}" APP_USER_PASSWORD="${APP_USER_PASSWORD:-e2e_a}" PLATFORM_OPS_PASSWORD="${PLATFORM_OPS_PASSWORD:-e2e_p}"
export BOOTSTRAP_DATABASE_URL="$BASE/$DB"
export MIGRATOR_DATABASE_URL="postgresql://migrator:$MIGRATOR_PASSWORD@$HOSTPART/$DB"
export PLATFORM_DATABASE_URL="postgresql://platform_ops:$PLATFORM_OPS_PASSWORD@$HOSTPART/$DB"
cd "$ROOT/apps/api"
node dist/src/cli/bootstrap.js
node dist/src/cli/migrate.js
node dist/src/cli/check-tenancy.js
node dist/src/cli/platform.js create-organization --name Fatboy --slug fatboy --timezone America/Tijuana \
  --branch VEN=Venecia --branch SMA="San Marcos" --branch AME=Américas \
  --admin-email dueno@fatboy.example --admin-name "Dueño Fatboy" --admin-password 'contraseña-larga-123' >/dev/null

export E2E_APP_DATABASE_URL="postgresql://app_user:$APP_USER_PASSWORD@$HOSTPART/$DB"  # también lo usa el E2E de reconciliación
DATABASE_URL="$E2E_APP_DATABASE_URL" PIN_PEPPER=e2e-pepper-e2e-pepper-e2e-pepper-1234 PORT=3900 node dist/src/main.js > /tmp/e2e-api.log 2>&1 &
API_PID=$!
cd "$ROOT/apps/web"
API_INTERNAL_URL=http://127.0.0.1:3900 node node_modules/next/dist/bin/next start -p 3901 > /tmp/e2e-web.log 2>&1 &
WEB_PID=$!
cleanup() {
  # `next start` lanza un proceso hijo "next-server": se detiene primero (antes de que quede huérfano)
  for pid in $(ps -eo pid,ppid | awk -v p="$WEB_PID" '$2 == p {print $1}'); do kill "$pid" 2>/dev/null || true; done
  kill "$API_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT
for i in $(seq 1 30); do curl -fs http://127.0.0.1:3900/health >/dev/null && curl -fs -o /dev/null http://127.0.0.1:3901/login && break; sleep 1; done
E2E_BASE_URL=http://127.0.0.1:3901 npx playwright test "$@"

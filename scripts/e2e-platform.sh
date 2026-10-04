#!/usr/bin/env bash
# E2E de la consola de plataforma contra PostgreSQL real: base limpia → roles → migraciones → operador → API de plataforma
# + API de clientes (solo para comprobar que activar/suspender cuentas se refleja de verdad) → consola web → Playwright.
# Requiere: PostgreSQL accesible con superusuario y `pnpm build` previo.
#   E2E_PG_SUPER_URL (default postgresql://postgres:postgres@127.0.0.1:5432/postgres)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPER_URL="${E2E_PG_SUPER_URL:-postgresql://postgres:postgres@127.0.0.1:5432/postgres}"
DB=checador_e2e_platform
BASE="${SUPER_URL%/*}"
HOSTPART="${BASE#*@}"
PLATFORM_API_PORT=3910 WEB_PORT=3911 TENANT_API_PORT=3912

for p in $PLATFORM_API_PORT $WEB_PORT $TENANT_API_PORT; do
  if curl -fs -o /dev/null "http://127.0.0.1:$p/" 2>/dev/null; then echo "Puerto $p ocupado por otro proceso" >&2; exit 1; fi
done
psql "$SUPER_URL" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
export MIGRATOR_PASSWORD="${MIGRATOR_PASSWORD:-e2e_m}" APP_USER_PASSWORD="${APP_USER_PASSWORD:-e2e_a}" PLATFORM_OPS_PASSWORD="${PLATFORM_OPS_PASSWORD:-e2e_p}"
export BOOTSTRAP_DATABASE_URL="$BASE/$DB"
export MIGRATOR_DATABASE_URL="postgresql://migrator:$MIGRATOR_PASSWORD@$HOSTPART/$DB"
export PLATFORM_DATABASE_URL="postgresql://platform_ops:$PLATFORM_OPS_PASSWORD@$HOSTPART/$DB"
cd "$ROOT/apps/api"
node dist/src/cli/bootstrap.js
node dist/src/cli/migrate.js
node dist/src/cli/check-tenancy.js
cd "$ROOT/apps/platform-api"
node dist/src/cli/platform-admin.js create-operator --email operador@plataforma.example --name "Operadora E2E" --password 'contraseña-larga-123' >/dev/null

PORT=$PLATFORM_API_PORT COOKIE_SECURE=false SWEEP_INTERVAL_SEC=0 node dist/src/main.js > /tmp/e2e-platform-api.log 2>&1 &
PAPI_PID=$!
cd "$ROOT/apps/api"
DATABASE_URL="postgresql://app_user:$APP_USER_PASSWORD@$HOSTPART/$DB" PIN_PEPPER=e2e-pepper-e2e-pepper-e2e-pepper-1234 PORT=$TENANT_API_PORT node dist/src/main.js > /tmp/e2e-platform-tenant.log 2>&1 &
TAPI_PID=$!
cd "$ROOT/apps/platform-web"
PLATFORM_API_INTERNAL_URL=http://127.0.0.1:$PLATFORM_API_PORT node node_modules/next/dist/bin/next start -p $WEB_PORT > /tmp/e2e-platform-web.log 2>&1 &
WEB_PID=$!
cleanup() {
  for pid in $(ps -eo pid,ppid | awk -v p="$WEB_PID" '$2 == p {print $1}'); do kill "$pid" 2>/dev/null || true; done
  kill "$PAPI_PID" "$TAPI_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT
for i in $(seq 1 30); do
  curl -fs http://127.0.0.1:$PLATFORM_API_PORT/health >/dev/null && curl -fs http://127.0.0.1:$TENANT_API_PORT/health >/dev/null && curl -fs -o /dev/null http://127.0.0.1:$WEB_PORT/login && break
  sleep 1
done
E2E_BASE_URL=http://127.0.0.1:$WEB_PORT E2E_TENANT_API=http://127.0.0.1:$TENANT_API_PORT npx playwright test "$@"

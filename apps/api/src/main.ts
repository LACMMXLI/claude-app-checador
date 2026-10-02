import 'reflect-metadata';
import { createHttpApp } from './app.module.js';
import { optionalEnv, requireEnv, requirePinPepper } from './config/env.js';
import { createContainer } from './container.js';
import { createPool } from './db/pool.js';

const pool = createPool(requireEnv('DATABASE_URL'));
const container = createContainer({ appPool: pool, pinPepper: requirePinPepper() });
const secureCookies = optionalEnv('COOKIE_SECURE', process.env.NODE_ENV === 'production' ? 'true' : 'false') === 'true';

const app = await createHttpApp({ pool, container, http: { secureCookies } });

// Reconciliación de asistencia DENTRO de la API (opcional; por defecto apagada). Alternativa: tarea programada
// de Coolify que ejecute `node dist/src/cli/reconcile.js`. Es idempotente: ambas pueden convivir.
const reconcileEverySec = Number(optionalEnv('RECONCILE_INTERVAL_SEC', '0'));
let reconcileTimer: NodeJS.Timeout | undefined;
if (reconcileEverySec > 0) {
  let running = false;
  reconcileTimer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const { errors } = await container.reconciler.reconcileAll();
      for (const e of errors) console.error(`reconciliación ${e.organizationId}: ${e.error}`);
    } catch (error) {
      console.error('reconciliación', error);
    } finally {
      running = false;
    }
  }, Math.max(30, reconcileEverySec) * 1000);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    if (reconcileTimer) clearInterval(reconcileTimer);
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
const port = Number(process.env.PORT ?? 3000);
await app.listen(port, '0.0.0.0');
console.log(`API escuchando en :${port}`);

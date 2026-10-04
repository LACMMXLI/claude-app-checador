import 'reflect-metadata';
import { createPool, optionalEnv, requireEnv, trustedProxyConfigFromEnv } from '@checador/api/platform';
import { createPlatformApp } from './app.module.js';
import { createContainer } from './container.js';

// ÚNICO servicio que recibe credenciales de plataforma (rol platform_ops). Debe quedar en su propio dominio y red.
const pool = createPool(requireEnv('PLATFORM_DATABASE_URL'), 5);
const container = createContainer({ platformPool: pool });
const secureCookies = optionalEnv('COOKIE_SECURE', process.env.NODE_ENV === 'production' ? 'true' : 'false') === 'true';
const app = await createPlatformApp({ pool, container, http: { secureCookies, trustedProxies: trustedProxyConfigFromEnv() } });

// Barrido de vencimientos (D-84): pasa a EXPIRED las pruebas/vigencias terminadas. Idempotente. 0 = apagado.
const sweepSec = Number(optionalEnv('SWEEP_INTERVAL_SEC', '60'));
let timer: NodeJS.Timeout | undefined;
const sweep = async () => {
  try {
    const expired = await container.subscriptions.expireDue();
    if (expired.length) console.log(`vencimientos: ${expired.length} suscripción(es) pasaron a EXPIRED`);
  } catch (error) {
    console.error('barrido de vencimientos', error);
  }
};
if (sweepSec > 0) {
  void sweep();
  timer = setInterval(() => void sweep(), Math.max(10, sweepSec) * 1000);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    if (timer) clearInterval(timer);
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
const port = Number(process.env.PORT ?? 3100);
await app.listen(port, '0.0.0.0');
console.log(`API de plataforma escuchando en :${port}`);

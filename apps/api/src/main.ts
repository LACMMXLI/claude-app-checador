import 'reflect-metadata';
import { createHttpApp } from './app.module.js';
import { optionalEnv, requireEnv, requirePinPepper } from './config/env.js';
import { createContainer } from './container.js';
import { createPool } from './db/pool.js';

const pool = createPool(requireEnv('DATABASE_URL'));
const container = createContainer({ appPool: pool, pinPepper: requirePinPepper() });
const secureCookies = optionalEnv('COOKIE_SECURE', process.env.NODE_ENV === 'production' ? 'true' : 'false') === 'true';

const app = await createHttpApp({ pool, container, http: { secureCookies } });
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
const port = Number(process.env.PORT ?? 3000);
await app.listen(port, '0.0.0.0');
console.log(`API escuchando en :${port}`);

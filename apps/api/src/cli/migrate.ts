import { migrate } from '../db/migrate.js';
import { requireEnv } from '../config/env.js';

const result = await migrate(requireEnv('MIGRATOR_DATABASE_URL'));
console.log(`Migraciones aplicadas: ${result.applied.length ? result.applied.join(', ') : '(ninguna nueva)'}`);

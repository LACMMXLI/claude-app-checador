import { createPool } from '../db/pool.js';
import { requireEnv } from '../config/env.js';

export const appPool = () => createPool(requireEnv('DATABASE_URL'));
export const platformPool = () => createPool(requireEnv('PLATFORM_DATABASE_URL'), 2);

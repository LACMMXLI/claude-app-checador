import { bootstrapRoles } from '../db/bootstrap.js';
import { requireEnv } from '../config/env.js';

await bootstrapRoles({
  superuserUrl: requireEnv('BOOTSTRAP_DATABASE_URL'),
  migratorPassword: requireEnv('MIGRATOR_PASSWORD'),
  appUserPassword: requireEnv('APP_USER_PASSWORD'),
  platformOpsPassword: requireEnv('PLATFORM_OPS_PASSWORD'),
});
console.log('Roles de PostgreSQL listos (migrator, app_user, platform_ops, gate_owner).');

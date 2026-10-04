import pg from 'pg';
import { bootstrapRoles, migrate } from '@checador/api/platform';
import { PASSWORDS, TEST_DB, URLS } from './helpers/config.js';

/** Base limpia + roles + TODAS las migraciones (como en producción). */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: URLS.maintenance });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(TEST_DB)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(TEST_DB)}`);
  } finally {
    await admin.end();
  }
  await bootstrapRoles({ superuserUrl: URLS.superuser, migratorPassword: PASSWORDS.migrator, appUserPassword: PASSWORDS.appUser, platformOpsPassword: PASSWORDS.platformOps });
  await migrate(URLS.migrator);
}

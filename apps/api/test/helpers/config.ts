const host = process.env.TEST_PG_HOST ?? '127.0.0.1';
const port = process.env.TEST_PG_PORT ?? '5432';
const superUser = process.env.TEST_PG_SUPERUSER ?? 'postgres';
const superPassword = process.env.TEST_PG_SUPERPASSWORD ?? 'postgres';

export const TEST_DB = process.env.TEST_PG_DATABASE ?? 'checador_test';
export const PASSWORDS = { migrator: 'migrator_pw_test', appUser: 'app_user_pw_test', platformOps: 'platform_ops_pw_test' };
export const PEPPER = 'test-pepper-0123456789-0123456789-0123456789';

const url = (user: string, password: string, db: string) =>
  `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${db}`;

export const URLS = {
  maintenance: url(superUser, superPassword, 'postgres'),
  superuser: url(superUser, superPassword, TEST_DB),
  migrator: url('migrator', PASSWORDS.migrator, TEST_DB),
  appUser: url('app_user', PASSWORDS.appUser, TEST_DB),
  platformOps: url('platform_ops', PASSWORDS.platformOps, TEST_DB),
};

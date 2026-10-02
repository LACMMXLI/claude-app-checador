import pg from 'pg';

export interface BootstrapOptions {
  /** URL de un SUPERUSUARIO sobre la base de datos destino. Solo se usa aquí. */
  superuserUrl: string;
  migratorPassword: string;
  appUserPassword: string;
  platformOpsPassword: string;
}

/**
 * Crea (o actualiza) los roles de PostgreSQL. Idempotente. Requiere superusuario porque
 * `platform_ops` y `gate_owner` llevan BYPASSRLS. `app_user` y `migrator` NUNCA lo tienen.
 *
 *  - migrator     dueño de los objetos / ejecuta migraciones   (NOSUPERUSER NOBYPASSRLS)
 *  - app_user     la API                                       (NOSUPERUSER NOBYPASSRLS)
 *  - platform_ops CLI de plataforma                            (BYPASSRLS)
 *  - gate_owner   dueño de las funciones-puerta, sin login     (BYPASSRLS, NOLOGIN)
 */
export async function bootstrapRoles(options: BootstrapOptions): Promise<void> {
  const client = new pg.Client({ connectionString: options.superuserUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
    const db = client.escapeIdentifier(rows[0]!.db);

    const upsertRole = async (name: string, attributes: string, password?: string) => {
      const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount === 1;
      const pw = password ? ` PASSWORD ${client.escapeLiteral(password)}` : '';
      await client.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${client.escapeIdentifier(name)} ${attributes}${pw}`);
    };

    await upsertRole('migrator', 'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', options.migratorPassword);
    await upsertRole('app_user', 'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', options.appUserPassword);
    await upsertRole('platform_ops', 'LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE', options.platformOpsPassword);
    await upsertRole('gate_owner', 'NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE');

    await client.query('GRANT gate_owner TO migrator');                       // para ALTER FUNCTION ... OWNER TO gate_owner
    await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO migrator, app_user, platform_ops`);
    await client.query(`GRANT CREATE ON DATABASE ${db} TO migrator`);         // crear esquemas y extensiones de confianza
    await client.query('GRANT CREATE ON SCHEMA public TO migrator');          // public.schema_migrations
    await client.query(`ALTER DATABASE ${db} SET timezone TO 'UTC'`);         // los instantes siempre en UTC
  } finally {
    await client.end();
  }
}

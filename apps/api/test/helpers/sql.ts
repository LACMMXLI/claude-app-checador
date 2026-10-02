import type { Pool, PoolClient, QueryResult } from 'pg';

/** Ejecuta SQL como `app_user` dentro de una transacción con el contexto de negocio fijado (siempre ROLLBACK). */
export async function asTenant<T>(pool: Pool, organizationId: string | null, fn: (c: PoolClient) => Promise<T>, userId = ''): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)`, [organizationId ?? '', userId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Devuelve el error de PostgreSQL (o null si la consulta no falló). Usa un SAVEPOINT para no abortar la transacción. */
export async function pgError(client: PoolClient, text: string, params: unknown[] = []): Promise<{ code?: string; message: string } | null> {
  await client.query('SAVEPOINT s');
  try {
    await client.query(text, params);
    await client.query('RELEASE SAVEPOINT s');
    return null;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT s');
    return error as { code?: string; message: string };
  }
}

export const count = async (c: { query: (q: string, p?: unknown[]) => Promise<QueryResult> }, text: string, params: unknown[] = []): Promise<number> =>
  Number((await c.query(text, params)).rows[0]?.count ?? 0);

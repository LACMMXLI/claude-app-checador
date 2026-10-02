import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from '../../db/schema/index.js';
import { type TenantContext, isUuid } from './tenant-context.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * ÚNICA puerta de acceso a datos de negocio de la API.
 *
 * Cada operación corre en una transacción donde se fija el negocio con `set_config(..., true)`
 * (alcance de transacción: no se filtra entre peticiones del pool). PostgreSQL aplica RLS con el
 * rol `app_user` (sin BYPASSRLS). Sin contexto ⇒ 0 filas.
 */
export class TenantDb {
  private readonly db: Db;

  constructor(pool: Pool) {
    this.db = drizzle(pool, { schema });
  }

  async run<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!isUuid(ctx.organizationId)) throw new Error('organizationId inválido');
    const userId = ctx.actor.userId ?? '';
    if (userId !== '' && !isUuid(userId)) throw new Error('userId inválido');
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.organization_id', ${ctx.organizationId}, true), set_config('app.user_id', ${userId}, true)`,
      );
      return fn(tx);
    });
  }

  /** Operación de un usuario autenticado SIN negocio seleccionado (p. ej. listar sus negocios al iniciar sesión). */
  async runAsUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!isUuid(userId)) throw new Error('userId inválido');
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.organization_id', '', true), set_config('app.user_id', ${userId}, true)`);
      return fn(tx);
    });
  }
}

import { Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { requireEnv, requirePinPepper } from './config/env.js';
import { type Container, createContainer } from './container.js';
import { createPool } from './db/pool.js';
import { HEALTH_CHECK, HealthController } from './http/health.controller.js';

export const PG_POOL = Symbol('PG_POOL');
export const CONTAINER = Symbol('CONTAINER');

/**
 * La API se conecta SIEMPRE con el rol `app_user` (sin BYPASSRLS). Los controladores de negocio
 * (Fase 1+) recibirán el contexto de negocio de la sesión/token del kiosco, nunca del cliente.
 */
@Module({
  controllers: [HealthController],
  providers: [
    { provide: PG_POOL, useFactory: (): Pool => createPool(requireEnv('DATABASE_URL')) },
    { provide: CONTAINER, inject: [PG_POOL], useFactory: (pool: Pool): Container => createContainer({ appPool: pool, pinPepper: requirePinPepper() }) },
    { provide: HEALTH_CHECK, inject: [PG_POOL], useFactory: (pool: Pool) => async () => (await pool.query('SELECT 1')).rowCount === 1 },
  ],
  exports: [CONTAINER],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createContainer } from '../../src/container.js';
import { PASSWORDS, PEPPER, URLS } from './config.js';

export const PASSWORD = 'una-contraseña-segura-123';
export const uniq = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export function openPools() {
  const mk = (connectionString: string, max = 5) => new pg.Pool({ connectionString, max });
  return {
    platform: mk(URLS.platformOps, 4),
    app: mk(URLS.appUser, 4),
    superuser: mk(URLS.superuser, 2),
    async close() {
      await Promise.all([this.platform.end(), this.app.end(), this.superuser.end()]);
    },
  };
}
export type Pools = ReturnType<typeof openPools>;

/** Reloj manejable para probar vencimientos y bloqueos sin esperar. */
export function makeClock(start = new Date()) {
  let now = start;
  return { now: () => now, set: (d: Date) => (now = d), advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

export function buildWorld(pools: Pools, clock: () => Date = () => new Date()) {
  return createContainer({ platformPool: pools.platform, clock });
}
export type World = ReturnType<typeof buildWorld>;

/** Operador listo para iniciar sesión. */
export async function makeOperator(world: World, name = uniq('op')) {
  const email = `${name}@plataforma.example`;
  const { operator } = await world.operators.create({ email, displayName: `Operador ${name}`, password: PASSWORD }, 'prueba');
  return { ...operator, email, password: PASSWORD };
}
export { PASSWORDS, PEPPER };

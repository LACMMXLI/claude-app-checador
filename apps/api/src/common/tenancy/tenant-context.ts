export type ActorType = 'USER' | 'SYSTEM' | 'KIOSK';

export interface Actor {
  type: ActorType;
  userId?: string;
  deviceId?: string;
}

/**
 * Contexto de negocio de una operación. Se construye SOLO a partir de la sesión autenticada o del
 * token del kiosco (nunca de datos que envíe el cliente) y se fija en PostgreSQL por transacción.
 */
export interface TenantContext {
  organizationId: string;
  actor: Actor;
  ip?: string;
  requestId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

import type { Pool, PoolClient } from 'pg';
import { isUuid } from '../tenancy/tenant-context.js';

/** Aviso de cambio (D-75): solo identificadores, nunca datos personales. Es una INVALIDACIÓN, no la fuente de verdad. */
export interface ChangeNotice {
  kind: 'session' | 'incident' | 'request';
  id: string;
  branchId: string | null;
  op: string;
}

interface Subscriber {
  onNotice: (n: ChangeNotice) => void;
  onResync: () => void;
}

const channelOf = (organizationId: string) => `att_${organizationId.replaceAll('-', '')}`;

/**
 * Puente PostgreSQL LISTEN/NOTIFY → suscriptores SSE de ESTE proceso. Una sola conexión dedicada; se escucha el canal de
 * un negocio solo mientras tenga suscriptores. El canal se deriva SIEMPRE del negocio de la sesión del suscriptor (nunca
 * del cliente). Si la conexión se pierde se reconecta y se pide `resync` a todos: perder un aviso nunca afecta la
 * consistencia porque el cliente vuelve a consultar por los endpoints normales (RBAC + RLS).
 */
export class NotificationHub {
  private client: PoolClient | null = null;
  private connecting: Promise<PoolClient> | null = null;
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private closed = false;

  constructor(private readonly pool: Pool) {}

  private async connection(): Promise<PoolClient> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = await this.pool.connect();
        client.on('notification', (msg) => this.dispatch(msg.channel, msg.payload));
        client.on('error', () => this.lost(client));
        client.on('end', () => this.lost(client));
        for (const org of this.subscribers.keys()) await client.query(`LISTEN ${channelOf(org)}`);
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private lost(client: PoolClient) {
    if (this.client !== client) return;
    this.client = null;
    try {
      client.release(true);
    } catch {
      /* ya liberada */
    }
    if (this.closed || this.subscribers.size === 0) return;
    // reconexión con espera corta; al volver, todos recargan (no hay garantía de entrega de lo ocurrido mientras tanto)
    setTimeout(() => {
      void this.connection()
        .then(() => this.forEachSubscriber((s) => s.onResync()))
        .catch(() => this.forEachSubscriber((s) => s.onResync()));
    }, 500).unref();
  }

  private forEachSubscriber(fn: (s: Subscriber) => void) {
    for (const set of this.subscribers.values()) for (const s of set) fn(s);
  }

  private dispatch(channel: string, payload: string | undefined) {
    const org = [...this.subscribers.keys()].find((o) => channelOf(o) === channel);
    if (!org || !payload) return;
    let parsed: { k?: string; id?: string; b?: string | null; op?: string };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (!parsed.id || !parsed.k || !['session', 'incident', 'request'].includes(parsed.k)) return;
    const notice: ChangeNotice = { kind: parsed.k as ChangeNotice['kind'], id: parsed.id, branchId: parsed.b ?? null, op: parsed.op ?? 'update' };
    for (const s of this.subscribers.get(org) ?? []) s.onNotice(notice);
  }

  /** Suscribe a los avisos de UN negocio. Devuelve la función para cancelar la suscripción. */
  async subscribe(organizationId: string, subscriber: Subscriber): Promise<() => Promise<void>> {
    if (!isUuid(organizationId)) throw new Error('organizationId inválido');
    this.closed = false;
    const set = this.subscribers.get(organizationId) ?? new Set<Subscriber>();
    const first = set.size === 0;
    set.add(subscriber);
    this.subscribers.set(organizationId, set);
    const client = await this.connection();
    if (first) await client.query(`LISTEN ${channelOf(organizationId)}`);
    return async () => {
      set.delete(subscriber);
      if (set.size > 0) return;
      this.subscribers.delete(organizationId);
      await this.client?.query(`UNLISTEN ${channelOf(organizationId)}`).catch(() => undefined);
    };
  }

  /** Para pruebas y diagnóstico: PID de la conexión LISTEN. */
  async backendPid(): Promise<number> {
    const client = await this.connection();
    return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscribers.clear();
    const client = this.client;
    this.client = null;
    if (client) {
      await client.query('UNLISTEN *').catch(() => undefined);
      client.release();
    }
  }
}

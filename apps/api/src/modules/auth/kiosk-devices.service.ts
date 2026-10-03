import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { DomainError } from '../../common/errors.js';
import type { Gate } from '../../common/tenancy/gate.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';
import { branches, kioskDevices, kioskPairingCodes, organizations } from '../../db/schema/index.js';
import type { AuditService } from '../audit/audit.service.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
// Alfabeto sin caracteres ambiguos (0/O, 1/I/L)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PREFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const randomString = (alphabet: string, length: number): string =>
  Array.from({ length }, () => alphabet[randomInt(0, alphabet.length)]).join('');

/** Token nuevo: prefijo público + secreto de 256 bits. En BD solo va el SHA-256 del secreto. */
function newToken() {
  const prefix = randomString(PREFIX_ALPHABET, 12);
  const secret = randomBytes(32).toString('base64url');
  return { prefix, hash: sha256(secret), token: `kt_${prefix}.${secret}` };
}

/** Formato del token del kiosco: `kt_<prefijo público de 12>.<secreto>`. */
export function parseKioskToken(token: string): { prefix: string; secret: string } | null {
  const m = /^kt_([A-Za-z0-9]{12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}

export interface KioskIdentity {
  deviceId: string;
  organizationId: string;
  branchId: string;
}

/**
 * Kioscos. El token pertenece obligatoriamente a organization_id + branch_id + device_id y se guarda
 * hasheado; el negocio y la sucursal de una checada SIEMPRE salen del token, nunca del cliente.
 */
export class KioskDevicesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly gate: Gate,
    private readonly audit: AuditService,
  ) {}

  /** El admin genera un código de un solo uso para emparejar una tablet con una sucursal. */
  async createPairingCode(ctx: TenantContext, branchId: string, ttlMinutes = 10): Promise<{ code: string; expiresAt: Date }> {
    return this.tenantDb.run(ctx, async (tx) => {
      const [branch] = await tx.select().from(branches).where(and(eq(branches.id, branchId), eq(branches.isActive, true)));
      if (!branch) throw new DomainError('BRANCH_NOT_FOUND');
      const code = randomString(CODE_ALPHABET, 8);
      const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
      await tx.insert(kioskPairingCodes).values({
        organizationId: ctx.organizationId,
        branchId,
        codeHash: sha256(code),
        expiresAt,
        createdBy: ctx.actor.userId ?? null,
      });
      await this.audit.record(tx, ctx, {
        action: 'kiosk.pairing_code_created', // el código NO se registra
        entityType: 'kiosk_pairing_code',
        branchId,
        after: { expiresAt },
      });
      return { code, expiresAt };
    });
  }

  /**
   * La tablet canjea el código y recibe su token (se muestra una sola vez). Aún no hay negocio
   * conocido: la función-puerta valida el código, crea el dispositivo y audita atómicamente.
   */
  async redeem(code: string, deviceName: string): Promise<{ token: string } & KioskIdentity> {
    const t = newToken();
    const redeemed = await this.gate.redeemPairingCode(sha256(code.trim().toUpperCase()), deviceName, t.prefix, t.hash);
    if (!redeemed) throw new DomainError('PAIRING_CODE_INVALID');
    return { token: t.token, ...redeemed };
  }

  /** Valida el token de un kiosco ⇒ identidad (device, negocio, sucursal). Es el origen del contexto del kiosco. */
  async authenticate(token: string): Promise<KioskIdentity> {
    const parsed = parseKioskToken(token);
    if (!parsed) throw new DomainError('KIOSK_TOKEN_INVALID');
    const record = await this.gate.resolveKioskToken(parsed.prefix);
    const expected = Buffer.from(sha256(parsed.secret), 'hex');
    const actual = Buffer.from(record?.tokenHash ?? '0'.repeat(64), 'hex');
    const matches = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!record || !matches || record.status !== 'ACTIVE' || record.organizationStatus !== 'ACTIVE') {
      throw new DomainError('KIOSK_TOKEN_INVALID');
    }
    return { deviceId: record.deviceId, organizationId: record.organizationId, branchId: record.branchId };
  }

  /**
   * D-56 · Activación del navegador del kiosco. Acepta el token completo (mostrado una vez en el panel) o un
   * código de emparejamiento. El servidor ROTA la credencial: el token que se pegó deja de servir (uso único,
   * no sirve para activar un segundo equipo) y la credencial nueva solo viaja en una cookie HttpOnly.
   */
  async activate(credential: string, deviceName = 'Kiosco'): Promise<{ token: string } & KioskIdentity> {
    const value = credential.trim();
    if (!value.startsWith('kt_')) return this.redeem(value, deviceName);
    const identity = await this.authenticate(value);
    const parsed = parseKioskToken(value)!;
    const t = newToken();
    const ctx = this.contextFor(identity);
    const activatedAt = new Date();
    await this.tenantDb.run(ctx, async (tx) => {
      const [rotated] = await tx
        .update(kioskDevices)
        .set({ tokenPrefix: t.prefix, tokenHash: t.hash, tokenIssuedAt: activatedAt, activatedAt, tokenRevokedAt: null })
        .where(and(eq(kioskDevices.id, identity.deviceId), eq(kioskDevices.tokenHash, sha256(parsed.secret))))
        .returning();
      if (!rotated) throw new DomainError('KIOSK_TOKEN_INVALID'); // otro navegador lo activó al mismo tiempo
      await this.audit.record(tx, ctx, { action: 'kiosk.activated', entityType: 'kiosk_device', entityId: identity.deviceId, branchId: identity.branchId, after: { tokenRotated: true } });
    });
    return { token: t.token, ...identity };
  }

  /** Lo que el kiosco necesita mostrar: negocio (nombre, marca), sucursal y dispositivo. Nada administrativo. */
  async describe(identity: KioskIdentity) {
    return this.tenantDb.run(this.contextFor(identity), async (tx) => {
      const [row] = await tx
        .select({ orgName: organizations.name, branding: organizations.branding, orgTz: organizations.timezone, branchName: branches.name, branchTz: branches.timezone, deviceName: kioskDevices.name })
        .from(kioskDevices)
        .innerJoin(branches, eq(branches.id, kioskDevices.branchId))
        .innerJoin(organizations, eq(organizations.id, kioskDevices.organizationId))
        .where(eq(kioskDevices.id, identity.deviceId));
      if (!row) throw new DomainError('KIOSK_TOKEN_INVALID');
      return {
        organization: { name: row.orgName, branding: row.branding },
        branch: { id: identity.branchId, name: row.branchName, timezone: row.branchTz ?? row.orgTz },
        device: { id: identity.deviceId, name: row.deviceName },
      };
    });
  }

  /** Contexto de negocio de un kiosco (actor KIOSK). */
  contextFor(identity: KioskIdentity, extra: { ip?: string; requestId?: string } = {}): TenantContext {
    return { organizationId: identity.organizationId, actor: { type: 'KIOSK', deviceId: identity.deviceId }, ...extra };
  }

  /**
   * Estado DERIVADO del dispositivo (D-76): sin credencial (revocada) · pendiente de activar (credencial emitida que
   * ningún navegador ha usado) · inactivo (desactivado) · activo.
   */
  static stateOf(d: { tokenHash: string | null; status: string; activatedAt: Date | null; tokenIssuedAt: Date | null }) {
    if (!d.tokenHash) return 'NO_CREDENTIAL' as const;
    if (d.status !== 'ACTIVE') return 'INACTIVE' as const;
    if (!d.activatedAt || (d.tokenIssuedAt && d.activatedAt.getTime() < d.tokenIssuedAt.getTime())) return 'PENDING_ACTIVATION' as const;
    return 'ACTIVE' as const;
  }

  /** Vista segura de un kiosco: nunca incluye el hash ni el prefijo del token. */
  private view(d: typeof kioskDevices.$inferSelect) {
    return {
      state: KioskDevicesService.stateOf(d),
      activatedAt: d.activatedAt,
      lastSeenIp: d.lastSeenIp,
      id: d.id,
      name: d.name,
      branchId: d.branchId,
      status: d.status,
      hasToken: d.tokenHash !== null,
      tokenIssuedAt: d.tokenIssuedAt,
      tokenRevokedAt: d.tokenRevokedAt,
      lastSeenAt: d.lastSeenAt,
      createdAt: d.createdAt,
    };
  }

  private async mustGet(tx: Tx, deviceId: string) {
    const [device] = await tx.select().from(kioskDevices).where(eq(kioskDevices.id, deviceId));
    if (!device) throw new DomainError('KIOSK_NOT_FOUND');
    return device;
  }

  private async assertBranch(tx: Tx, branchId: string) {
    const [branch] = await tx.select().from(branches).where(eq(branches.id, branchId));
    if (!branch) throw new DomainError('BRANCH_NOT_FOUND');
    if (!branch.isActive) throw new DomainError('BRANCH_INACTIVE');
  }

  list(ctx: TenantContext) {
    return this.tenantDb.run(ctx, async (tx) => (await tx.select().from(kioskDevices).orderBy(kioskDevices.name)).map((d) => this.view(d)));
  }

  get(ctx: TenantContext, deviceId: string) {
    return this.tenantDb.run(ctx, async (tx) => this.view(await this.mustGet(tx, deviceId)));
  }

  /** Crea el dispositivo ligado a una sucursal y emite su token (el token completo se muestra UNA vez). */
  async create(ctx: TenantContext, input: { name: string; branchId: string }) {
    return this.tenantDb.run(ctx, async (tx) => {
      await this.assertBranch(tx, input.branchId);
      const t = newToken();
      const [device] = await tx
        .insert(kioskDevices)
        .values({ organizationId: ctx.organizationId, branchId: input.branchId, name: input.name, tokenPrefix: t.prefix, tokenHash: t.hash, tokenIssuedAt: new Date() })
        .returning();
      await this.audit.record(tx, ctx, { action: 'kiosk.created', entityType: 'kiosk_device', entityId: device!.id, branchId: input.branchId, after: this.view(device!) });
      return { device: this.view(device!), token: t.token };
    });
  }

  /** Regenera el token: el anterior deja de funcionar en ese mismo instante. */
  async regenerateToken(ctx: TenantContext, deviceId: string, reason?: string) {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.mustGet(tx, deviceId);
      const t = newToken();
      const [after] = await tx
        .update(kioskDevices)
        .set({ tokenPrefix: t.prefix, tokenHash: t.hash, tokenIssuedAt: new Date(), tokenRevokedAt: null })
        .where(eq(kioskDevices.id, deviceId))
        .returning();
      await this.audit.record(tx, ctx, { action: 'kiosk.token_regenerated', entityType: 'kiosk_device', entityId: deviceId, branchId: before.branchId, before: this.view(before), after: this.view(after!), reason });
      return { device: this.view(after!), token: t.token };
    });
  }

  /** Revoca el token (el dispositivo queda sin credencial hasta regenerarla). */
  async revokeToken(ctx: TenantContext, deviceId: string, reason?: string) {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.mustGet(tx, deviceId);
      const [after] = await tx
        .update(kioskDevices)
        .set({ tokenPrefix: null, tokenHash: null, tokenIssuedAt: null, tokenRevokedAt: new Date() })
        .where(eq(kioskDevices.id, deviceId))
        .returning();
      await this.audit.record(tx, ctx, { action: 'kiosk.token_revoked', entityType: 'kiosk_device', entityId: deviceId, branchId: before.branchId, before: this.view(before), after: this.view(after!), reason });
      return this.view(after!);
    });
  }

  /** Activa/desactiva el dispositivo (inactivo: su token no autentica, aunque exista). */
  async setStatus(ctx: TenantContext, deviceId: string, status: 'ACTIVE' | 'INACTIVE', reason?: string) {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.mustGet(tx, deviceId);
      const [after] = await tx.update(kioskDevices).set({ status }).where(eq(kioskDevices.id, deviceId)).returning();
      await this.audit.record(tx, ctx, { action: 'kiosk.status_changed', entityType: 'kiosk_device', entityId: deviceId, branchId: before.branchId, before: { status: before.status }, after: { status }, reason });
      return this.view(after!);
    });
  }

  /** Renombrar o reasignar a otra sucursal DEL MISMO negocio (FK compuesta). */
  async update(ctx: TenantContext, deviceId: string, patch: { name?: string; branchId?: string }, reason?: string) {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.mustGet(tx, deviceId);
      if (patch.branchId) await this.assertBranch(tx, patch.branchId);
      const [after] = await tx.update(kioskDevices).set(patch).where(eq(kioskDevices.id, deviceId)).returning();
      await this.audit.record(tx, ctx, { action: 'kiosk.updated', entityType: 'kiosk_device', entityId: deviceId, branchId: after!.branchId, before: this.view(before), after: this.view(after!), reason });
      return this.view(after!);
    });
  }

  /** Compatibilidad Fase 0: revocar = quitar el token. */
  revoke(ctx: TenantContext, deviceId: string, reason?: string) {
    return this.revokeToken(ctx, deviceId, reason);
  }

  /** Último uso del dispositivo (a lo más una escritura por minuto: el kiosco consulta seguido). */
  async touch(ctx: TenantContext, deviceId: string, ip?: string): Promise<void> {
    await this.tenantDb.run(ctx, (tx) =>
      tx
        .update(kioskDevices)
        .set({ lastSeenAt: new Date(), lastSeenIp: ip ? ip.slice(0, 64) : null })
        .where(and(eq(kioskDevices.id, deviceId), or(isNull(kioskDevices.lastSeenAt), lt(kioskDevices.lastSeenAt, sql`now() - interval '1 minute'`)))),
    );
  }
}

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DomainError } from '../../common/errors.js';
import type { Gate } from '../../common/tenancy/gate.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { TenantDb } from '../../common/tenancy/tenant-db.js';
import { branches, kioskDevices, kioskPairingCodes } from '../../db/schema/index.js';
import type { AuditService } from '../audit/audit.service.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
// Alfabeto sin caracteres ambiguos (0/O, 1/I/L)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PREFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const randomString = (alphabet: string, length: number): string =>
  Array.from({ length }, () => alphabet[randomInt(0, alphabet.length)]).join('');

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
    const prefix = randomString(PREFIX_ALPHABET, 12);
    const secret = randomBytes(32).toString('base64url');
    const redeemed = await this.gate.redeemPairingCode(sha256(code.trim().toUpperCase()), deviceName, prefix, sha256(secret));
    if (!redeemed) throw new DomainError('PAIRING_CODE_INVALID');
    return { token: `kt_${prefix}.${secret}`, ...redeemed };
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

  /** Contexto de negocio de un kiosco (actor KIOSK). */
  contextFor(identity: KioskIdentity, extra: { ip?: string; requestId?: string } = {}): TenantContext {
    return { organizationId: identity.organizationId, actor: { type: 'KIOSK', deviceId: identity.deviceId }, ...extra };
  }

  async revoke(ctx: TenantContext, deviceId: string, reason?: string): Promise<void> {
    await this.tenantDb.run(ctx, async (tx) => {
      const [device] = await tx.select().from(kioskDevices).where(eq(kioskDevices.id, deviceId));
      if (!device) throw new DomainError('KIOSK_NOT_FOUND');
      if (device.status === 'REVOKED') return;
      await tx.update(kioskDevices).set({ status: 'REVOKED', revokedAt: new Date() }).where(eq(kioskDevices.id, deviceId));
      await this.audit.record(tx, ctx, {
        action: 'kiosk.revoked',
        entityType: 'kiosk_device',
        entityId: deviceId,
        branchId: device.branchId,
        before: { status: 'ACTIVE' },
        after: { status: 'REVOKED' },
        reason,
      });
    });
  }

  async touch(ctx: TenantContext, deviceId: string): Promise<void> {
    await this.tenantDb.run(ctx, (tx) => tx.update(kioskDevices).set({ lastSeenAt: new Date() }).where(eq(kioskDevices.id, deviceId)));
  }
}

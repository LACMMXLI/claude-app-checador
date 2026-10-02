import type { Pool } from 'pg';
import { isUuid } from './tenant-context.js';

export interface KioskTokenRecord {
  deviceId: string;
  organizationId: string;
  branchId: string;
  tokenHash: string;
  status: string;
  organizationStatus: string;
}

export interface LoginRecord {
  userId: string;
  status: string;
  passwordHash: string;
  failedAttempts: number;
  lockedUntil: Date | null;
}

export interface MembershipChoice {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
}

/**
 * Las únicas consultas que ocurren ANTES de conocer el negocio. Cada una llama a una función
 * `SECURITY DEFINER` (dueño `gate_owner`) que expone lo mínimo indispensable.
 */
export class Gate {
  constructor(private readonly pool: Pool) {}

  async resolveKioskToken(prefix: string): Promise<KioskTokenRecord | null> {
    const { rows } = await this.pool.query(`SELECT * FROM auth.resolve_kiosk_token($1)`, [prefix]);
    const r = rows[0];
    if (!r) return null;
    return {
      deviceId: r.device_id,
      organizationId: r.organization_id,
      branchId: r.branch_id,
      tokenHash: r.token_hash,
      status: r.status,
      organizationStatus: r.organization_status,
    };
  }

  async redeemPairingCode(
    codeHash: string,
    deviceName: string,
    tokenPrefix: string,
    tokenHash: string,
  ): Promise<{ deviceId: string; organizationId: string; branchId: string } | null> {
    const { rows } = await this.pool.query(`SELECT * FROM auth.redeem_pairing_code($1, $2, $3, $4)`, [
      codeHash,
      deviceName,
      tokenPrefix,
      tokenHash,
    ]);
    const r = rows[0];
    return r ? { deviceId: r.r_device_id, organizationId: r.r_organization_id, branchId: r.r_branch_id } : null;
  }

  async getLoginRecord(email: string): Promise<LoginRecord | null> {
    const { rows } = await this.pool.query(`SELECT * FROM auth.get_login_record($1)`, [email]);
    const r = rows[0];
    return r
      ? { userId: r.user_id, status: r.status, passwordHash: r.password_hash, failedAttempts: r.failed_attempts, lockedUntil: r.locked_until }
      : null;
  }

  async recordLoginResult(userId: string, success: boolean): Promise<void> {
    await this.pool.query(`SELECT auth.record_login_result($1, $2)`, [userId, success]);
  }

  /** Negocios activos del usuario (para elegir negocio al iniciar sesión). */
  async listUserMemberships(userId: string): Promise<MembershipChoice[]> {
    if (!isUuid(userId)) throw new Error('userId inválido');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
      const { rows } = await client.query(`SELECT * FROM auth.list_user_memberships()`);
      await client.query('COMMIT');
      return rows.map((r) => ({
        membershipId: r.membership_id,
        organizationId: r.organization_id,
        organizationName: r.organization_name,
        organizationSlug: r.organization_slug,
      }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listActiveOrganizations(): Promise<string[]> {
    const { rows } = await this.pool.query(`SELECT organization_id FROM core.list_active_organizations()`);
    return rows.map((r) => r.organization_id as string);
  }
}

import type { Pool } from 'pg';
import { DomainError } from '../errors.js';
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

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  /** null si no hay negocio activo, o si la membresía/negocio dejaron de estar activos. */
  organizationId: string | null;
  membershipId: string | null;
  expiresAt: Date;
}

export interface InvitationPreview {
  invitationId: string;
  organizationId: string;
  organizationName: string;
  email: string;
  expiresAt: Date;
  userExists: boolean;
}

/** Errores lanzados por funciones-puerta con RAISE 'CODIGO' (SQLSTATE P0001) ⇒ código de dominio. */
function gateErrorCode(error: unknown): string | null {
  const e = error as { code?: string; message?: string };
  return e?.code === 'P0001' && e.message && /^[A-Z_]+$/.test(e.message) ? e.message : null;
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

  // ── Sesiones ─────────────────────────────────────────────────────────────────
  async createSession(userId: string, tokenHash: string, expiresAt: Date, ip: string | null, userAgent: string | null): Promise<string> {
    try {
      const { rows } = await this.pool.query('SELECT auth.create_session($1, $2, $3, $4, $5) AS id', [userId, tokenHash, expiresAt, ip, userAgent]);
      return rows[0].id;
    } catch (error) {
      const code = gateErrorCode(error);
      if (code) throw new DomainError(code);
      throw error;
    }
  }

  async resolveSession(tokenHash: string): Promise<ResolvedSession | null> {
    const { rows } = await this.pool.query('SELECT * FROM auth.resolve_session($1)', [tokenHash]);
    const r = rows[0];
    return r
      ? { sessionId: r.session_id, userId: r.user_id, email: r.email, displayName: r.display_name, organizationId: r.organization_id, membershipId: r.membership_id, expiresAt: r.expires_at }
      : null;
  }

  /** Cambia el negocio activo ROTANDO la sesión. null = membresía/negocio no válidos (no cambia nada). */
  async switchSessionOrganization(oldHash: string, newHash: string, organizationId: string, ttlSeconds: number): Promise<{ sessionId: string; membershipId: string } | null> {
    if (!isUuid(organizationId)) return null;
    const { rows } = await this.pool.query('SELECT * FROM auth.switch_session_organization($1, $2, $3, $4)', [oldHash, newHash, organizationId, ttlSeconds]);
    const r = rows[0];
    return r ? { sessionId: r.r_session_id, membershipId: r.r_membership_id } : null;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.pool.query('SELECT auth.revoke_session($1)', [tokenHash]);
  }

  /**
   * D-80 · Cambia la contraseña de la propia persona (compare-and-set sobre el hash ya verificado) y revoca sus demás
   * sesiones. Devuelve cuántas sesiones se revocaron.
   */
  async changePassword(userId: string, oldHash: string, newHash: string, keepSessionHash: string | null): Promise<number> {
    try {
      const { rows } = await this.pool.query('SELECT auth.change_password($1, $2, $3, $4) AS revoked', [userId, oldHash, newHash, keepSessionHash]);
      return rows[0].revoked as number;
    } catch (error) {
      const code = gateErrorCode(error);
      if (code) throw new DomainError(code);
      throw error;
    }
  }

  // ── Invitaciones ─────────────────────────────────────────────────────────────
  async getInvitation(tokenHash: string): Promise<InvitationPreview | null> {
    const { rows } = await this.pool.query('SELECT * FROM auth.get_invitation($1)', [tokenHash]);
    const r = rows[0];
    return r
      ? { invitationId: r.invitation_id, organizationId: r.organization_id, organizationName: r.organization_name, email: r.email, expiresAt: r.expires_at, userExists: r.user_exists }
      : null;
  }

  async acceptInvitation(
    tokenHash: string,
    displayName: string | null,
    passwordHash: string | null,
    verifiedUserId: string | null,
  ): Promise<{ userId: string; organizationId: string; membershipId: string; createdUser: boolean }> {
    try {
      const { rows } = await this.pool.query('SELECT * FROM auth.accept_invitation($1, $2, $3, $4)', [tokenHash, displayName, passwordHash, verifiedUserId]);
      const r = rows[0];
      return { userId: r.r_user_id, organizationId: r.r_organization_id, membershipId: r.r_membership_id, createdUser: r.r_created_user };
    } catch (error) {
      const code = gateErrorCode(error);
      if (code) throw new DomainError(code);
      throw error;
    }
  }

  async listActiveOrganizations(): Promise<string[]> {
    const { rows } = await this.pool.query(`SELECT organization_id FROM core.list_active_organizations()`);
    return rows.map((r) => r.organization_id as string);
  }
}

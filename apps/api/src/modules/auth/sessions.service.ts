import { createHash, randomBytes } from 'node:crypto';
import { DomainError } from '../../common/errors.js';
import type { Gate, ResolvedSession } from '../../common/tenancy/gate.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { AuthService } from './auth.service.js';

export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
/** Identificador de sesión: 256 bits aleatorios. Solo viaja en la cookie; en BD va su SHA-256. */
const newSessionToken = () => randomBytes(32).toString('base64url');
const isTokenShaped = (t: string) => /^[A-Za-z0-9_-]{43}$/.test(t);

export interface LoginOutcome {
  token: string;
  session: ResolvedSession;
}

/**
 * Sesiones del panel: identidad autenticada ≠ negocio activo.
 *   login → identidad → membresías → negocio activo (sesión) → TenantDb
 * El negocio activo SOLO lo fija el servidor (al validar la membresía) y cada cambio ROTA la sesión.
 */
export class SessionsService {
  constructor(
    private readonly gate: Gate,
    private readonly auth: AuthService,
    private readonly ttlSeconds = SESSION_TTL_SECONDS,
  ) {}

  /** Login: verifica credenciales, revoca la sesión previa (si venía una) y emite una NUEVA. Con un solo negocio, lo selecciona. */
  async login(email: string, password: string, meta: { previousToken?: string | null; ip?: string | null; userAgent?: string | null }): Promise<LoginOutcome> {
    const result = await this.auth.authenticate(email, password);
    if (meta.previousToken && isTokenShaped(meta.previousToken)) await this.gate.revokeSession(sha256(meta.previousToken));
    let token = newSessionToken();
    await this.gate.createSession(result.userId, sha256(token), new Date(Date.now() + this.ttlSeconds * 1000), meta.ip ?? null, meta.userAgent ?? null);
    if (!result.needsOrganizationChoice) {
      const only = result.memberships[0]!;
      const rotated = newSessionToken();
      const switched = await this.gate.switchSessionOrganization(sha256(token), sha256(rotated), only.organizationId, this.ttlSeconds);
      if (switched) token = rotated;
    }
    const session = await this.gate.resolveSession(sha256(token));
    if (!session) throw new DomainError('UNAUTHENTICATED');
    return { token, session };
  }

  async resolve(token: string | undefined | null): Promise<ResolvedSession | null> {
    if (!token || !isTokenShaped(token)) return null;
    return this.gate.resolveSession(sha256(token));
  }

  /** Seleccionar/cambiar de negocio: revalida la membresía y rota el identificador. */
  async switchOrganization(token: string, organizationId: string): Promise<LoginOutcome> {
    if (!isTokenShaped(token)) throw new DomainError('UNAUTHENTICATED');
    const rotated = newSessionToken();
    const switched = await this.gate.switchSessionOrganization(sha256(token), sha256(rotated), organizationId, this.ttlSeconds);
    if (!switched) throw new DomainError('MEMBERSHIP_NOT_AVAILABLE');
    const session = await this.gate.resolveSession(sha256(rotated));
    if (!session) throw new DomainError('UNAUTHENTICATED');
    return { token: rotated, session };
  }

  async logout(token: string | undefined | null): Promise<void> {
    if (token && isTokenShaped(token)) await this.gate.revokeSession(sha256(token));
  }

  /** Contexto de negocio derivado de la sesión (nunca de la petición). */
  static tenantContext(session: ResolvedSession, extra: { ip?: string; requestId?: string } = {}): TenantContext {
    if (!session.organizationId) throw new DomainError('NO_ACTIVE_ORGANIZATION');
    return { organizationId: session.organizationId, actor: { type: 'USER', userId: session.userId }, ...extra };
  }
}

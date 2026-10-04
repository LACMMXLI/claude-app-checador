import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { DomainError, hashPassword, MIN_PASSWORD_LENGTH, PlatformDb, schema, verifyPassword } from '@checador/api/platform';
import { generatePassword, isTokenShaped, newSessionToken, sha256 } from './secrets.js';

const { operators, operatorSessions, platformAuditLog } = schema;

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MS = 15 * 60 * 1000;

export interface OperatorView {
  id: string;
  email: string;
  displayName: string;
  status: 'ACTIVE' | 'DISABLED';
  lastLoginAt: Date | null;
  createdAt: Date;
}
const view = (o: typeof operators.$inferSelect): OperatorView => ({
  id: o.id, email: o.email, displayName: o.displayName, status: o.status as OperatorView['status'], lastLoginAt: o.lastLoginAt, createdAt: o.createdAt,
});

/** Identificador de quien actúa en bitácoras e historial. */
export const actorLabel = (op: Pick<OperatorView, 'email'>) => `operator:${op.email}`;

/**
 * Operadores de la plataforma (D-82). Identidad propia y separada de los usuarios de los negocios; sesión en cookie
 * HttpOnly (8 h, SHA-256 en BD) y bloqueo temporal tras 5 fallos seguidos. Todos los operadores tienen los mismos permisos.
 */
export class OperatorsService {
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly db: PlatformDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Hash de relleno: verificar contra algo aunque el correo no exista evita revelar qué correos son operadores. */
  private fakeHash() {
    return (this.dummyHash ??= hashPassword('relleno-para-igualar-tiempos'));
  }

  async login(email: string, password: string, meta: { previousToken?: string | null; ip?: string | null; userAgent?: string | null } = {}) {
    const now = this.clock();
    const normalized = email.trim().toLowerCase();
    const found = await this.db.run(async (tx) => (await tx.select().from(operators).where(eq(operators.email, normalized)))[0]);
    if (!found || found.status !== 'ACTIVE') {
      await verifyPassword(await this.fakeHash(), password);
      throw new DomainError('INVALID_CREDENTIALS');
    }
    if (found.lockedUntil && found.lockedUntil > now) throw new DomainError('ACCOUNT_LOCKED');
    const ok = await verifyPassword(found.passwordHash, password);
    if (!ok) {
      await this.db.run(async (tx) => {
        const attempts = found.failedAttempts + 1;
        const lock = attempts >= MAX_FAILED_ATTEMPTS;
        await tx.update(operators).set({ failedAttempts: lock ? 0 : attempts, lockedUntil: lock ? new Date(now.getTime() + LOCK_MS) : null }).where(eq(operators.id, found.id));
        if (lock) await tx.insert(platformAuditLog).values({ actor: `operator:${found.email}`, action: 'operator.locked', details: { until: new Date(now.getTime() + LOCK_MS).toISOString(), ip: meta.ip ?? null } });
      });
      throw new DomainError('INVALID_CREDENTIALS');
    }
    const token = newSessionToken();
    await this.db.run(async (tx) => {
      if (meta.previousToken && isTokenShaped(meta.previousToken)) {
        await tx.update(operatorSessions).set({ revokedAt: now }).where(eq(operatorSessions.tokenHash, sha256(meta.previousToken)));
      }
      await tx.update(operators).set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: now }).where(eq(operators.id, found.id));
      await tx.insert(operatorSessions).values({ operatorId: found.id, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + SESSION_TTL_MS), ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null });
      await tx.insert(platformAuditLog).values({ actor: `operator:${found.email}`, action: 'operator.login', details: { ip: meta.ip ?? null } });
    });
    return { token, operator: view({ ...found, lastLoginAt: now }) };
  }

  /** Operador de una sesión vigente (no revocada, no vencida y con el operador activo). */
  async resolve(token: string | null | undefined): Promise<OperatorView | null> {
    if (!token || !isTokenShaped(token)) return null;
    const now = this.clock();
    return this.db.run(async (tx) => {
      const [row] = await tx
        .select({ op: operators })
        .from(operatorSessions)
        .innerJoin(operators, eq(operators.id, operatorSessions.operatorId))
        .where(and(eq(operatorSessions.tokenHash, sha256(token)), sql`${operatorSessions.revokedAt} is null`, sql`${operatorSessions.expiresAt} > ${now}`, eq(operators.status, 'ACTIVE')));
      return row ? view(row.op) : null;
    });
  }

  async logout(token: string | null | undefined): Promise<void> {
    if (!token || !isTokenShaped(token)) return;
    await this.db.run((tx) => tx.update(operatorSessions).set({ revokedAt: this.clock() }).where(eq(operatorSessions.tokenHash, sha256(token))));
  }

  async list(): Promise<OperatorView[]> {
    return this.db.run(async (tx) => (await tx.select().from(operators).orderBy(asc(operators.createdAt))).map(view));
  }

  /** Alta de un operador. Sin contraseña se genera una y se devuelve UNA vez (nunca se registra). */
  async create(input: { email: string; displayName: string; password?: string }, actor: string): Promise<{ operator: OperatorView; initialPassword: string | null }> {
    const password = input.password ?? generatePassword();
    if (password.length < MIN_PASSWORD_LENGTH) throw new DomainError('PASSWORD_TOO_SHORT');
    const passwordHash = await hashPassword(password);
    return this.db.run(async (tx) => {
      const [existing] = await tx.select({ id: operators.id }).from(operators).where(eq(operators.email, input.email));
      if (existing) throw new DomainError('OPERATOR_EMAIL_TAKEN');
      const [op] = await tx.insert(operators).values({ email: input.email, displayName: input.displayName, passwordHash }).returning();
      await tx.insert(platformAuditLog).values({ actor, action: 'operator.created', details: { operatorId: op!.id, email: op!.email } });
      return { operator: view(op!), initialPassword: input.password ? null : password };
    }, { actor });
  }

  async setStatus(id: string, status: 'ACTIVE' | 'DISABLED', actorOperator: OperatorView): Promise<OperatorView> {
    if (status === 'DISABLED' && id === actorOperator.id) throw new DomainError('CANNOT_DISABLE_SELF');
    return this.db.run(async (tx) => {
      const [target] = await tx.select().from(operators).where(eq(operators.id, id)).for('update');
      if (!target) throw new DomainError('OPERATOR_NOT_FOUND');
      if (status === 'DISABLED') {
        const others = await tx.select({ id: operators.id }).from(operators).where(and(eq(operators.status, 'ACTIVE'), ne(operators.id, id)));
        if (others.length === 0) throw new DomainError('LAST_OPERATOR');
      }
      const [op] = await tx.update(operators).set({ status }).where(eq(operators.id, id)).returning();
      if (status === 'DISABLED') await tx.update(operatorSessions).set({ revokedAt: this.clock() }).where(and(eq(operatorSessions.operatorId, id), sql`${operatorSessions.revokedAt} is null`));
      await tx.insert(platformAuditLog).values({ actor: actorLabel(actorOperator), action: 'operator.status_changed', details: { operatorId: id, email: target.email, status } });
      return view(op!);
    });
  }

  /** Restablece la contraseña de otro operador: genera una nueva (se muestra una vez), desbloquea y cierra sus sesiones. */
  async resetPassword(id: string, actorOperator: OperatorView): Promise<{ operator: OperatorView; password: string }> {
    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    return this.db.run(async (tx) => {
      const [op] = await tx.update(operators).set({ passwordHash, failedAttempts: 0, lockedUntil: null }).where(eq(operators.id, id)).returning();
      if (!op) throw new DomainError('OPERATOR_NOT_FOUND');
      await tx.update(operatorSessions).set({ revokedAt: this.clock() }).where(and(eq(operatorSessions.operatorId, id), sql`${operatorSessions.revokedAt} is null`));
      await tx.insert(platformAuditLog).values({ actor: actorLabel(actorOperator), action: 'operator.password_reset', details: { operatorId: id, email: op.email } }); // sin la contraseña
      return { operator: view(op), password };
    });
  }

  /** CLI (sin sesión): mismo efecto que `resetPassword` pero con la contraseña indicada. */
  async resetPasswordByEmail(email: string, password: string, actor = 'platform-admin-cli'): Promise<void> {
    if (password.length < MIN_PASSWORD_LENGTH) throw new DomainError('PASSWORD_TOO_SHORT');
    const passwordHash = await hashPassword(password);
    await this.db.run(async (tx) => {
      const [op] = await tx.update(operators).set({ passwordHash, failedAttempts: 0, lockedUntil: null }).where(eq(operators.email, email.trim().toLowerCase())).returning();
      if (!op) throw new DomainError('OPERATOR_NOT_FOUND');
      await tx.update(operatorSessions).set({ revokedAt: this.clock() }).where(and(eq(operatorSessions.operatorId, op.id), sql`${operatorSessions.revokedAt} is null`));
      await tx.insert(platformAuditLog).values({ actor, action: 'operator.password_reset', details: { operatorId: op.id, email: op.email } });
    });
  }

  /** Cambio de la PROPIA contraseña: exige la actual, conserva esta sesión y cierra las demás. */
  async changeOwnPassword(operatorId: string, currentPassword: string, newPassword: string, currentToken: string | null): Promise<void> {
    if (newPassword.length < MIN_PASSWORD_LENGTH) throw new DomainError('PASSWORD_TOO_SHORT');
    const now = this.clock();
    const [op] = await this.db.run((tx) => tx.select().from(operators).where(eq(operators.id, operatorId)));
    if (!op || !(await verifyPassword(op.passwordHash, currentPassword))) throw new DomainError('CURRENT_PASSWORD_INVALID');
    if (currentPassword === newPassword) throw new DomainError('NEW_PASSWORD_SAME_AS_CURRENT');
    const passwordHash = await hashPassword(newPassword);
    await this.db.run(async (tx) => {
      await tx.update(operators).set({ passwordHash }).where(eq(operators.id, operatorId));
      const keep = currentToken && isTokenShaped(currentToken) ? sha256(currentToken) : '';
      await tx.update(operatorSessions).set({ revokedAt: now }).where(and(eq(operatorSessions.operatorId, operatorId), sql`${operatorSessions.revokedAt} is null`, ne(operatorSessions.tokenHash, keep)));
      await tx.insert(platformAuditLog).values({ actor: `operator:${op.email}`, action: 'operator.password_changed', details: { operatorId } });
    });
  }
}

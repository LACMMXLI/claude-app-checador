import { DomainError } from '../../common/errors.js';
import type { Gate, MembershipChoice } from '../../common/tenancy/gate.js';
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from './password.js';

export interface AuthenticationResult {
  userId: string;
  /** Si hay exactamente un negocio, la sesión puede fijarse directo; si hay varios, el usuario elige. */
  memberships: MembershipChoice[];
  needsOrganizationChoice: boolean;
}

// Hash de relleno para igualar el tiempo de respuesta cuando el correo no existe
const DUMMY_HASH_PROMISE = hashPassword('contraseña-de-relleno-no-valida');

/**
 * Autenticación de la identidad GLOBAL (correo + contraseña). La contraseña pertenece a la plataforma:
 * el administrador de un negocio no puede verla ni cambiarla (RN-IDN-02).
 */
export class AuthService {
  constructor(private readonly gate: Gate) {}

  async authenticate(email: string, password: string, now: () => Date = () => new Date()): Promise<AuthenticationResult> {
    const record = await this.gate.getLoginRecord(email);
    if (!record) {
      await verifyPassword(await DUMMY_HASH_PROMISE, password); // evita revelar si el correo existe por tiempo
      throw new DomainError('INVALID_CREDENTIALS');
    }
    if (record.status !== 'ACTIVE') throw new DomainError('INVALID_CREDENTIALS');
    if (record.lockedUntil && record.lockedUntil > now()) throw new DomainError('ACCOUNT_LOCKED');

    const ok = await verifyPassword(record.passwordHash, password);
    await this.gate.recordLoginResult(record.userId, ok);
    if (!ok) throw new DomainError('INVALID_CREDENTIALS');

    const memberships = await this.gate.listUserMemberships(record.userId);
    if (memberships.length === 0) throw new DomainError('NO_ACTIVE_MEMBERSHIP');
    return { userId: record.userId, memberships, needsOrganizationChoice: memberships.length > 1 };
  }

  /**
   * D-80 · Cambio de contraseña por la PROPIA persona. Exige la contraseña actual (con el mismo bloqueo por intentos que
   * el login), una nueva distinta y de al menos 10 caracteres, y revoca las demás sesiones. Nunca se registra ninguna
   * contraseña ni hash. El administrador de un negocio no tiene ningún camino a la contraseña de otra persona (RN-IDN-02).
   */
  async changePassword(
    email: string,
    currentPassword: string,
    newPassword: string,
    keepSessionHash: string | null,
    now: () => Date = () => new Date(),
  ): Promise<{ otherSessionsRevoked: number }> {
    if (newPassword.length < MIN_PASSWORD_LENGTH) throw new DomainError('PASSWORD_TOO_SHORT');
    const record = await this.gate.getLoginRecord(email);
    if (!record || record.status !== 'ACTIVE') throw new DomainError('CURRENT_PASSWORD_INVALID');
    if (record.lockedUntil && record.lockedUntil > now()) throw new DomainError('ACCOUNT_LOCKED');
    const ok = await verifyPassword(record.passwordHash, currentPassword);
    await this.gate.recordLoginResult(record.userId, ok);
    if (!ok) throw new DomainError('CURRENT_PASSWORD_INVALID');
    if (currentPassword === newPassword) throw new DomainError('NEW_PASSWORD_SAME_AS_CURRENT');
    const revoked = await this.gate.changePassword(record.userId, record.passwordHash, await hashPassword(newPassword), keepSessionHash);
    return { otherSessionsRevoked: revoked };
  }
}

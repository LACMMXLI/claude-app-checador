import { DomainError } from '../../common/errors.js';
import type { Gate, MembershipChoice } from '../../common/tenancy/gate.js';
import { hashPassword, verifyPassword } from './password.js';

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
}

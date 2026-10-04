import { eq } from 'drizzle-orm';
import { DomainError, PlatformAdminService, PlatformDb, schema } from '@checador/api/platform';
import { generatePassword } from './secrets.js';

const { users } = schema;

/** Soporte a clientes: restablecer la contraseña GLOBAL de una persona (mientras no exista recuperación por correo). */
export class SupportService {
  constructor(
    private readonly db: PlatformDb,
    private readonly admin: PlatformAdminService,
  ) {}

  /** La contraseña nueva se devuelve UNA vez; en bitácora solo queda quién la restableció y a qué cuenta (nunca la contraseña). */
  async resetUserPassword(email: string, actor: string): Promise<{ email: string; password: string }> {
    const normalized = email.trim().toLowerCase();
    const [user] = await this.db.run((tx) => tx.select({ id: users.id }).from(users).where(eq(users.email, normalized)));
    if (!user) throw new DomainError('USER_NOT_FOUND');
    const password = generatePassword();
    await this.admin.resetPassword(normalized, password, actor);
    return { email: normalized, password };
  }
}

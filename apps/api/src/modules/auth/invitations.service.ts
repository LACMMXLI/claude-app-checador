import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError } from '../../common/errors.js';
import type { Gate } from '../../common/tenancy/gate.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { TenantDb } from '../../common/tenancy/tenant-db.js';
import { branches, invitations, organizationMemberships, roles, users } from '../../db/schema/index.js';
import type { AuditService } from '../audit/audit.service.js';
import { hashPassword, verifyPassword } from './password.js';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
export const INVITATION_TTL_HOURS = 72;

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  roleId: z.string().uuid(),
  scope: z.discriminatedUnion('type', [
    z.object({ type: z.literal('ORGANIZATION') }),
    z.object({ type: z.literal('BRANCHES'), branchIds: z.array(z.string().uuid()).min(1) }),
  ]),
});
export type InviteInput = z.infer<typeof inviteSchema>;

/**
 * Invitaciones (D-11): el admin invita un correo con rol y alcance; el invitado RECLAMA la cuenta
 * y pone SUS credenciales. Si el correo ya es una identidad global, no se crea otra ni se toca su
 * contraseña: solo se agrega la membresía. El token: 256 bits, guardado hasheado, uso único, con vencimiento.
 */
export class InvitationsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly gate: Gate,
    private readonly audit: AuditService,
    private readonly ttlHours = INVITATION_TTL_HOURS,
  ) {}

  /** Devuelve el token UNA sola vez (para que el admin lo entregue). Nunca se registra ni se guarda en claro. */
  async invite(ctx: TenantContext, raw: InviteInput): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
    const input = inviteSchema.parse(raw);
    return this.tenantDb.run(ctx, async (tx) => {
      const [role] = await tx.select().from(roles).where(eq(roles.id, input.roleId));
      if (!role) throw new DomainError('ROLE_NOT_FOUND');
      const branchIds = input.scope.type === 'BRANCHES' ? [...new Set(input.scope.branchIds)] : [];
      if (branchIds.length) {
        const found = await tx.select({ id: branches.id }).from(branches).where(inArray(branches.id, branchIds));
        if (found.length !== branchIds.length) throw new DomainError('BRANCH_NOT_FOUND');
      }
      // ¿ya es miembro activo de ESTE negocio? (RLS: solo membresías de este negocio)
      const existing = await tx
        .select({ status: organizationMemberships.status })
        .from(organizationMemberships)
        .innerJoin(users, eq(users.id, organizationMemberships.userId))
        .where(eq(users.email, input.email));
      if (existing.some((m) => m.status === 'ACTIVE')) throw new DomainError('ALREADY_MEMBER');
      // una sola invitación pendiente por correo: la nueva reemplaza a la anterior
      await tx
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(and(eq(invitations.email, input.email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));

      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + this.ttlHours * 3600_000);
      const [inv] = await tx
        .insert(invitations)
        .values({
          organizationId: ctx.organizationId,
          email: input.email,
          roleId: input.roleId,
          scope: input.scope.type,
          branchIds,
          tokenHash: sha256(token),
          expiresAt,
          createdBy: ctx.actor.userId ?? null,
        })
        .returning();
      await this.audit.record(tx, ctx, {
        action: 'invitation.created',
        entityType: 'invitation',
        entityId: inv!.id,
        after: { email: input.email, roleId: input.roleId, scope: input.scope.type, branchIds, expiresAt },
      });
      return { invitationId: inv!.id, token, expiresAt };
    });
  }

  list(ctx: TenantContext) {
    return this.tenantDb.run(ctx, (tx) =>
      tx
        .select({
          id: invitations.id,
          email: invitations.email,
          roleId: invitations.roleId,
          scope: invitations.scope,
          branchIds: invitations.branchIds,
          expiresAt: invitations.expiresAt,
          acceptedAt: invitations.acceptedAt,
          revokedAt: invitations.revokedAt,
          createdAt: invitations.createdAt,
        })
        .from(invitations)
        .orderBy(desc(invitations.createdAt)),
    );
  }

  async revoke(ctx: TenantContext, invitationId: string) {
    await this.tenantDb.run(ctx, async (tx) => {
      const [inv] = await tx.select().from(invitations).where(eq(invitations.id, invitationId));
      if (!inv) throw new DomainError('INVITATION_NOT_FOUND');
      if (inv.acceptedAt || inv.revokedAt) return;
      await tx.update(invitations).set({ revokedAt: new Date() }).where(eq(invitations.id, invitationId));
      await this.audit.record(tx, ctx, { action: 'invitation.revoked', entityType: 'invitation', entityId: invitationId });
    });
  }

  /** Vista previa pública (sin sesión): negocio, correo y si ya existe la identidad. */
  async preview(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new DomainError('INVITATION_INVALID');
    const inv = await this.gate.getInvitation(sha256(token));
    if (!inv) throw new DomainError('INVITATION_INVALID');
    return inv;
  }

  /**
   * Reclamar la invitación. Identidad nueva: elige su contraseña. Identidad existente: debe probar que es
   * dueña de la cuenta con su contraseña ACTUAL (que no se modifica).
   */
  async accept(token: string, input: { password: string; displayName?: string }) {
    const inv = await this.preview(token);
    if (inv.userExists) {
      const record = await this.gate.getLoginRecord(inv.email);
      if (!record || record.status !== 'ACTIVE' || !(await verifyPassword(record.passwordHash, input.password))) {
        throw new DomainError('INVALID_CREDENTIALS');
      }
      return this.gate.acceptInvitation(sha256(token), null, null, record.userId);
    }
    if (!input.password || input.password.length < 10) throw new DomainError('PASSWORD_TOO_SHORT');
    return this.gate.acceptInvitation(sha256(token), input.displayName ?? null, await hashPassword(input.password), null);
  }
}

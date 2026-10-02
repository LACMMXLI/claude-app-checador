import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { inviteSchema } from '../../modules/auth/invitations.service.js';
import { RequestAuth } from '../request-auth.js';
import { CONTAINER } from '../tokens.js';
import { parse } from '../validation.js';

const statusSchema = z.object({ status: z.enum(['ACTIVE', 'INACTIVE', 'REMOVED']), reason: z.string().max(500).optional() });
const roleSchema = z.object({
  roleId: z.string().uuid(),
  scope: z.discriminatedUnion('type', [
    z.object({ type: z.literal('ORGANIZATION') }),
    z.object({ type: z.literal('BRANCHES'), branchIds: z.array(z.string().uuid()).min(1) }),
  ]),
  reason: z.string().max(500).optional(),
});
const linkSchema = z.object({ employeeId: z.string().uuid().nullable() });

/**
 * Usuarios del negocio = MEMBRESÍAS. No existe ninguna ruta para ver o cambiar contraseñas globales
 * (D-11): la identidad pertenece a la plataforma; aquí solo se invita, activa, desactiva o quita.
 */
@Controller()
export class MembersController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(RequestAuth) private readonly auth: RequestAuth,
  ) {}

  private async admin(req: Request) {
    const t = await this.auth.tenant(req);
    t.access.assert('memberships.manage');
    return t;
  }

  @Get('members')
  async list(@Req() req: Request) {
    return this.c.memberships.listWithRoles((await this.admin(req)).ctx);
  }

  @Get('roles')
  async roles(@Req() req: Request) {
    return this.c.memberships.listRoles((await this.admin(req)).ctx);
  }

  @Patch('members/:id/status')
  async setStatus(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx } = await this.admin(req);
    const input = parse(statusSchema, body);
    return this.c.memberships.setStatus(ctx, id, input.status, input.reason);
  }

  @Post('members/:id/roles')
  async assignRole(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access } = await this.admin(req);
    access.assert('roles.manage');
    const input = parse(roleSchema, body);
    return this.c.memberships.assignRole(ctx, id, input.roleId, input.scope, input.reason);
  }

  @Delete('role-assignments/:id')
  @HttpCode(204)
  async revokeRole(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const { ctx, access } = await this.admin(req);
    access.assert('roles.manage');
    await this.c.memberships.revokeRole(ctx, id);
  }

  /** Relación opcional cuenta ↔ ficha de empleado (D-15). */
  @Patch('members/:id/employee')
  async linkEmployee(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx } = await this.admin(req);
    return this.c.memberships.linkEmployee(ctx, id, parse(linkSchema, body).employeeId);
  }

  // ── Invitaciones ─────────────────────────────────────────────────────────────
  @Get('invitations')
  async listInvitations(@Req() req: Request) {
    return this.c.invitations.list((await this.admin(req)).ctx);
  }

  /** Devuelve el token de invitación UNA vez (para entregarlo al usuario mientras no haya correo). */
  @Post('invitations')
  async invite(@Req() req: Request, @Body() body: unknown) {
    const { ctx, access } = await this.admin(req);
    const input = parse(inviteSchema, body);
    if (input.scope.type === 'BRANCHES') input.scope.branchIds.forEach((b) => access.assert('memberships.manage', b));
    const result = await this.c.invitations.invite(ctx, input);
    return { invitationId: result.invitationId, token: result.token, acceptPath: `/invitacion/${result.token}`, expiresAt: result.expiresAt };
  }

  @Post('invitations/:id/revoke')
  @HttpCode(204)
  async revokeInvitation(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.c.invitations.revoke((await this.admin(req)).ctx, id);
  }
}

import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ResolvedSession } from '../../common/tenancy/gate.js';
import type { Container } from '../../container.js';
import { SESSION_TTL_SECONDS, SessionsService } from '../../modules/auth/sessions.service.js';
import { RequestAuth } from '../request-auth.js';
import { CONTAINER, HTTP_CONFIG, type HttpConfig, sessionCookieName } from '../tokens.js';
import { parse } from '../validation.js';

const loginSchema = z.object({ email: z.string().trim().min(3).max(320), password: z.string().min(1).max(1024) });
const switchSchema = z.object({ organizationId: z.string().uuid() });
const acceptSchema = z.object({ password: z.string().min(1).max(1024), displayName: z.string().trim().max(120).optional() });

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(RequestAuth) private readonly auth: RequestAuth,
    @Inject(HTTP_CONFIG) private readonly cfg: HttpConfig,
  ) {}

  /** La sesión viaja SOLO en una cookie HttpOnly (nunca en localStorage ni en el cuerpo de la respuesta). */
  private setCookie(res: Response, token: string) {
    res.cookie(sessionCookieName(this.cfg), token, {
      httpOnly: true,
      secure: this.cfg.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
  }

  private clearCookie(res: Response) {
    res.clearCookie(sessionCookieName(this.cfg), { httpOnly: true, secure: this.cfg.secureCookies, sameSite: 'lax', path: '/' });
  }

  private async describe(session: ResolvedSession) {
    const memberships = await this.c.gate.listUserMemberships(session.userId);
    let permissions: Record<string, 'ALL' | string[]> = {};
    let employeeId: string | null = null;
    if (session.organizationId && session.membershipId) {
      const ctx = SessionsService.tenantContext(session);
      const access = await this.c.rbac.loadAccess(ctx, session.membershipId);
      permissions = access.summary();
      employeeId = access.employeeId; // ficha ligada a la membresía: habilita "Mis jornadas" (decisión 1)
    }
    return {
      user: { id: session.userId, email: session.email, displayName: session.displayName },
      memberships: memberships.map((m) => ({ organizationId: m.organizationId, name: m.organizationName, slug: m.organizationSlug })),
      activeOrganization: memberships.find((m) => m.organizationId === session.organizationId)
        ? { id: session.organizationId, name: memberships.find((m) => m.organizationId === session.organizationId)!.organizationName }
        : null,
      permissions,
      employeeId,
      expiresAt: session.expiresAt,
    };
  }

  @Post('login')
  @HttpCode(200)
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const input = parse(loginSchema, body);
    const { token, session } = await this.c.sessions.login(input.email, input.password, {
      previousToken: this.auth.token(req),
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    this.setCookie(res, token); // identificador NUEVO tras el login (rotación)
    return this.describe(session);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.c.sessions.logout(this.auth.token(req));
    this.clearCookie(res);
  }

  @Get('me')
  async me(@Req() req: Request) {
    return this.describe(await this.auth.identity(req));
  }

  /** Selecciona/cambia de negocio: el servidor valida la membresía y ROTA la sesión. */
  @Post('switch-organization')
  @HttpCode(200)
  async switchOrganization(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const { organizationId } = parse(switchSchema, body);
    await this.auth.identity(req);
    const { token, session } = await this.c.sessions.switchOrganization(this.auth.token(req)!, organizationId);
    this.setCookie(res, token);
    return this.describe(session);
  }

  // ── Invitaciones (públicas: el token ES la credencial; uso único) ─────────────
  @Get('invitations/:token')
  async previewInvitation(@Param('token') token: string) {
    const inv = await this.c.invitations.preview(token);
    return { organizationName: inv.organizationName, email: inv.email, expiresAt: inv.expiresAt, userExists: inv.userExists };
  }

  @Post('invitations/:token/accept')
  @HttpCode(200)
  async acceptInvitation(@Param('token') token: string, @Body() body: unknown) {
    const input = parse(acceptSchema, body);
    const result = await this.c.invitations.accept(token, input);
    return { organizationId: result.organizationId, createdUser: result.createdUser };
  }
}

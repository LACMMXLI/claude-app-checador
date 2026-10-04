import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { clientIp } from '@checador/api/platform';
import type { Container } from '../../container.js';
import { SESSION_TTL_MS } from '../../modules/operators.service.js';
import { RequestAuth } from '../request-auth.js';
import { CONTAINER, HTTP_CONFIG, type HttpConfig, sessionCookieName } from '../tokens.js';
import { parse } from '../validation.js';

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) });
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(10).max(200) });

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(HTTP_CONFIG) private readonly cfg: HttpConfig,
    @Inject(RequestAuth) private readonly auth: RequestAuth,
  ) {}

  private setCookie(res: Response, token: string) {
    res.cookie(sessionCookieName(this.cfg), token, { httpOnly: true, sameSite: 'strict', secure: this.cfg.secureCookies, path: '/', maxAge: SESSION_TTL_MS });
  }

  @Post('login')
  @HttpCode(200)
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const input = parse(loginSchema, body);
    const { token, operator } = await this.c.operators.login(input.email, input.password, {
      previousToken: this.auth.token(req),
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    });
    this.setCookie(res, token);
    return { operator: { id: operator.id, email: operator.email, displayName: operator.displayName } };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.c.operators.logout(this.auth.token(req));
    res.clearCookie(sessionCookieName(this.cfg), { httpOnly: true, sameSite: 'strict', secure: this.cfg.secureCookies, path: '/' });
  }

  @Get('me')
  async me(@Req() req: Request) {
    const { operator } = await this.auth.operator(req);
    return { operator: { id: operator.id, email: operator.email, displayName: operator.displayName } };
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(@Req() req: Request, @Body() body: unknown) {
    const { operator, token } = await this.auth.operator(req);
    const input = parse(changePasswordSchema, body);
    await this.c.operators.changeOwnPassword(operator.id, input.currentPassword, input.newPassword, token);
  }
}

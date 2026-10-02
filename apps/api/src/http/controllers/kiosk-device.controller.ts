import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { DomainError } from '../../common/errors.js';
import type { Container } from '../../container.js';
import { PUNCH_ACTIONS } from '../../modules/attendance/attendance-common.js';
import type { KioskIdentity } from '../../modules/auth/kiosk-devices.service.js';
import { readCookie } from '../request-auth.js';
import { CONTAINER, HTTP_CONFIG, type HttpConfig, kioskCookieName } from '../tokens.js';
import { parse } from '../validation.js';

const activateSchema = z.object({ credential: z.string().trim().min(6).max(200), deviceName: z.string().trim().min(1).max(80).optional() });
const identifySchema = z.object({ pin: z.string().max(12) });
const punchSchema = z.object({
  ticket: z.string().min(10).max(1000),
  action: z.enum(PUNCH_ACTIONS as unknown as [string, ...string[]]),
  clientEventId: z.string().uuid(),
});

/** El navegador del kiosco se vuelve a activar si pasa un año sin uso (la cookie se renueva en cada petición). */
const KIOSK_COOKIE_MAX_AGE_MS = 365 * 24 * 3600 * 1000;

/**
 * API del DISPOSITIVO (sin sesión de usuario). Credencial: cookie HttpOnly `kiosk`/`__Host-kiosk` establecida
 * al ACTIVAR (D-56) o, para integraciones, `Authorization: Bearer kt_…`. El negocio, la sucursal y el
 * dispositivo salen SIEMPRE de esa credencial, jamás del cuerpo de la petición. Un token revocado o un
 * dispositivo desactivado dejan de funcionar en la siguiente petición.
 */
@Controller('kiosk')
export class KioskDeviceController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(HTTP_CONFIG) private readonly cfg: HttpConfig,
  ) {}

  private setCookie(res: Response, token: string) {
    res.cookie(kioskCookieName(this.cfg), token, {
      httpOnly: true,
      secure: this.cfg.secureCookies,
      sameSite: 'strict',
      path: '/',
      maxAge: KIOSK_COOKIE_MAX_AGE_MS,
    });
  }

  private clearCookie(res: Response) {
    res.clearCookie(kioskCookieName(this.cfg), { httpOnly: true, secure: this.cfg.secureCookies, sameSite: 'strict', path: '/' });
  }

  private credential(req: Request): string | null {
    const header = req.header('authorization') ?? '';
    if (header.startsWith('Bearer ')) return header.slice(7).trim();
    return readCookie(req, kioskCookieName(this.cfg));
  }

  private async device(req: Request, res: Response): Promise<KioskIdentity> {
    const token = this.credential(req);
    if (!token) throw new DomainError('KIOSK_NOT_ACTIVATED');
    try {
      const identity = await this.c.kiosks.authenticate(token);
      if (!req.header('authorization')) this.setCookie(res, token); // renovación deslizante
      return identity;
    } catch (error) {
      if (!req.header('authorization')) this.clearCookie(res);
      throw error;
    }
  }

  @Post('activate')
  @HttpCode(200)
  async activate(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const input = parse(activateSchema, body);
    const result = await this.c.kiosks.activate(input.credential, input.deviceName);
    this.setCookie(res, result.token); // el token NUEVO solo viaja en la cookie HttpOnly
    return this.c.kiosks.describe(result);
  }

  @Post('deactivate')
  @HttpCode(200)
  deactivate(@Res({ passthrough: true }) res: Response) {
    this.clearCookie(res);
    return { ok: true };
  }

  /** Pantalla inicial: negocio, sucursal, reloj del servidor. 401 si el navegador no está activado o se revocó. */
  @Get('session')
  async session(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const identity = await this.device(req, res);
    const ctx = this.c.kiosks.contextFor(identity, { ip: req.ip });
    await this.c.kiosks.touch(ctx, identity.deviceId);
    return { ...(await this.c.kiosks.describe(identity)), serverTime: new Date() };
  }

  /** PIN → pase corto + acciones posibles (D-39). El PIN nunca se registra (D-58). */
  @Post('identify')
  @HttpCode(200)
  async identify(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const identity = await this.device(req, res);
    const ctx = this.c.kiosks.contextFor(identity, { ip: req.ip });
    await this.c.kiosks.touch(ctx, identity.deviceId);
    return this.c.kioskAttendance.identify(ctx, identity, parse(identifySchema, body).pin);
  }

  /** Entrada · Salida a comer · Regreso de comer · Salida. Idempotente por `clientEventId` (D-54). */
  @Post('punch')
  @HttpCode(200)
  async punch(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const identity = await this.device(req, res);
    const ctx = this.c.kiosks.contextFor(identity, { ip: req.ip });
    const input = parse(punchSchema, body);
    return this.c.kioskAttendance.punch(ctx, identity, { ...input, action: input.action as (typeof PUNCH_ACTIONS)[number] });
  }
}

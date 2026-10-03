import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { DomainError } from '../../common/errors.js';
import type { Container } from '../../container.js';
import { PUNCH_ACTIONS } from '../../modules/attendance/attendance-common.js';
import { REQUEST_ACTIONS, type RequestAction } from '../../modules/attendance/correction-requests.service.js';
import type { KioskIdentity } from '../../modules/auth/kiosk-devices.service.js';
import { readCookie } from '../request-auth.js';
import { CONTAINER, HTTP_CONFIG, type HttpConfig, kioskCookieName } from '../tokens.js';
import { parse } from '../validation.js';
import { clientIp } from '../client-ip.js';

const activateSchema = z.object({ credential: z.string().trim().min(6).max(200), deviceName: z.string().trim().min(1).max(80).optional() });
const identifySchema = z.object({ pin: z.string().max(12) });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const localInstant = z.object({ date, time, fold: z.enum(['EARLIER', 'LATER']).optional() });
const ticketSchema = z.object({ ticket: z.string().min(10).max(1000) });
const requestSchema = z.object({
  ticket: z.string().min(10).max(1000),
  clientRequestId: z.string().uuid(),
  action: z.enum(REQUEST_ACTIONS as unknown as [string, ...string[]]),
  workSessionId: z.string().uuid().nullish(),
  breakId: z.string().uuid().nullish(),
  shiftId: z.string().uuid().nullish(),
  start: localInstant,
  end: localInstant.nullish(),
  reason: z.string().max(500),
});
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
      await this.c.kiosks.touch(this.c.kiosks.contextFor(identity), identity.deviceId, clientIp(req)); // último uso (D-76), IP de D-79
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
    return { ...(await this.c.kiosks.describe(identity)), serverTime: new Date() };
  }

  /** PIN → pase corto + acciones posibles (D-39). El PIN nunca se registra (D-58). */
  @Post('identify')
  @HttpCode(200)
  async identify(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const identity = await this.device(req, res);
    const ctx = this.c.kiosks.contextFor(identity, { ip: clientIp(req) ?? undefined });
    return this.c.kioskAttendance.identify(ctx, identity, parse(identifySchema, body).pin);
  }

  /** Entrada · Salida a comer · Regreso de comer · Salida. Idempotente por `clientEventId` (D-54). */
  @Post('punch')
  @HttpCode(200)
  async punch(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const identity = await this.device(req, res);
    const ctx = this.c.kiosks.contextFor(identity, { ip: clientIp(req) ?? undefined });
    const input = parse(punchSchema, body);
    return this.c.kioskAttendance.punch(ctx, identity, { ...input, action: input.action as (typeof PUNCH_ACTIONS)[number] });
  }

  /** "Mis registros": solo la propia ficha (identificada por el pase), solo la ventana de solicitud, datos mínimos. */
  @Post('my-records')
  @HttpCode(200)
  async myRecords(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const identity = await this.device(req, res);
    return this.c.kioskAttendance.myRecords(this.c.kiosks.contextFor(identity, { ip: clientIp(req) ?? undefined }), identity, parse(ticketSchema, body).ticket);
  }

  /** Solicitar una corrección (D-70): nunca modifica la jornada; queda PENDIENTE de aprobación. Idempotente. */
  @Post('correction-requests')
  @HttpCode(200)
  async requestCorrection(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    const identity = await this.device(req, res);
    const { ticket, ...input } = parse(requestSchema, body);
    // la sucursal de una jornada no registrada sin turno es la del kiosco (donde está físicamente el empleado)
    return this.c.kioskAttendance.requestCorrection(this.c.kiosks.contextFor(identity, { ip: clientIp(req) ?? undefined }), identity, ticket, {
      ...input,
      action: input.action as RequestAction,
      branchId: input.action === 'CREATE_SESSION' && !input.shiftId ? identity.branchId : null,
    });
  }

  @Post('correction-requests/:id/cancel')
  @HttpCode(200)
  async cancelRequest(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const identity = await this.device(req, res);
    return this.c.kioskAttendance.cancelRequest(this.c.kiosks.contextFor(identity, { ip: clientIp(req) ?? undefined }), identity, parse(ticketSchema, body).ticket, id);
  }
}

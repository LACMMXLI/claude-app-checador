import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { DomainError } from '../../common/errors.js';
import type { Container } from '../../container.js';
import { RequestAuth } from '../request-auth.js';
import { CONTAINER } from '../tokens.js';
import { parse } from '../validation.js';

const createSchema = z.object({ name: z.string().trim().min(1).max(80), branchId: z.string().uuid() });
const updateSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), branchId: z.string().uuid().optional(), reason: z.string().max(500).optional() });
const statusSchema = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']), reason: z.string().max(500).optional() });
const reasonSchema = z.object({ reason: z.string().max(500).optional() });
const identifySchema = z.object({ pin: z.string().max(12) });

/** Panel de kioscos. El token completo solo aparece en la respuesta de crear/regenerar. */
@Controller('kiosks')
export class KiosksController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(RequestAuth) private readonly auth: RequestAuth,
  ) {}

  private async admin(req: Request) {
    const t = await this.auth.tenant(req);
    t.access.assert('kiosks.manage');
    return t;
  }

  @Get()
  async list(@Req() req: Request) {
    return this.c.kiosks.list((await this.admin(req)).ctx);
  }

  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    const { ctx, access } = await this.admin(req);
    const input = parse(createSchema, body);
    access.assert('kiosks.manage', input.branchId);
    return this.c.kiosks.create(ctx, input);
  }

  @Patch(':id')
  async update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx } = await this.admin(req);
    const { reason, ...patch } = parse(updateSchema, body);
    return this.c.kiosks.update(ctx, id, patch, reason);
  }

  @Post(':id/token')
  @HttpCode(200)
  async regenerate(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.c.kiosks.regenerateToken((await this.admin(req)).ctx, id, parse(reasonSchema, body).reason);
  }

  @Post(':id/token/revoke')
  @HttpCode(200)
  async revoke(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.c.kiosks.revokeToken((await this.admin(req)).ctx, id, parse(reasonSchema, body).reason);
  }

  @Post(':id/status')
  @HttpCode(200)
  async setStatus(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(statusSchema, body);
    return this.c.kiosks.setStatus((await this.admin(req)).ctx, id, input.status, input.reason);
  }
}

/**
 * API del DISPOSITIVO (sin cookie): se autentica con `Authorization: Bearer kt_…`. El negocio y la
 * sucursal salen del token. Fase 1 solo expone la identificación por PIN (las checadas llegan en Fase 3).
 */
@Controller('kiosk')
export class KioskDeviceController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post('identify')
  @HttpCode(200)
  async identify(@Req() req: Request, @Body() body: unknown) {
    const header = req.header('authorization') ?? '';
    if (!header.startsWith('Bearer ')) throw new DomainError('KIOSK_TOKEN_INVALID');
    const identity = await this.c.kiosks.authenticate(header.slice(7).trim());
    const ctx = this.c.kiosks.contextFor(identity, { ip: req.ip });
    await this.c.kiosks.touch(ctx, identity.deviceId);
    const employee = await this.c.kioskIdentification.identify(ctx, identity.branchId, parse(identifySchema, body).pin);
    return { employee: { id: employee.id, firstName: employee.firstName, lastName: employee.lastName } };
  }
}

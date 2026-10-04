import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { Container } from '../../container.js';
import { RequestAuth } from '../request-auth.js';
import { CONTAINER } from '../tokens.js';

/**
 * Plan del negocio (D-87): solo lectura y solo el del negocio de la sesión (plan, estado, vigencia, límites y uso).
 * Las notas internas y cualquier dato de otros negocios no existen para este rol de base de datos.
 */
@Controller('subscription')
export class SubscriptionController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(RequestAuth) private readonly auth: RequestAuth,
  ) {}

  @Get()
  async get(@Req() req: Request) {
    const { ctx } = await this.auth.tenant(req);
    return this.c.entitlements.view(ctx);
  }
}

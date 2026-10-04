import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { Container } from '../../container.js';
import { createCustomerSchema, listCustomersSchema } from '../../modules/customers.service.js';
import { RequestAuth } from '../request-auth.js';
import { CONTAINER } from '../tokens.js';
import { parse } from '../validation.js';

/** Clientes (negocios) y su suscripción. Cada operación la hace un operador autenticado y queda en la bitácora. */
@Controller('customers')
export class CustomersController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(RequestAuth) private readonly auth: RequestAuth,
  ) {}

  @Get()
  async list(@Req() req: Request, @Query() q: unknown) {
    await this.auth.operator(req);
    return this.c.customers.list(parse(listCustomersSchema, q));
  }

  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    const { actor } = await this.auth.operator(req);
    return this.c.customers.create(parse(createCustomerSchema, body), actor);
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.auth.operator(req);
    return this.c.customers.get(id);
  }

  @Get(':id/history')
  async history(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.auth.operator(req);
    const [events, audit] = await Promise.all([this.c.subscriptions.events(id), this.c.audit.list({ organizationId: id, limit: 100 })]);
    return { events, audit };
  }

  // ── Ciclo de vida de la suscripción (D-84) ───────────────────────────────────
  @Post(':id/subscription/change-plan')
  @HttpCode(200)
  async changePlan(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { actor } = await this.auth.operator(req);
    return this.c.subscriptions.changePlan(id, parse(this.c.subscriptions.schemas.changePlan, body).planCode, actor);
  }

  @Post(':id/subscription/activate')
  @HttpCode(200)
  async activate(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { actor } = await this.auth.operator(req);
    return this.c.subscriptions.activate(id, parse(this.c.subscriptions.schemas.activate, body), actor);
  }

  @Post(':id/subscription/start-trial')
  @HttpCode(200)
  async startTrial(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { actor } = await this.auth.operator(req);
    return this.c.subscriptions.startTrial(id, parse(this.c.subscriptions.schemas.startTrial, body), actor);
  }

  @Post(':id/subscription/extend')
  @HttpCode(200)
  async extend(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { actor } = await this.auth.operator(req);
    return { subscription: await this.c.subscriptions.extend(id, parse(this.c.subscriptions.schemas.extend, body).until, actor), warnings: [] };
  }

  @Post(':id/subscription/suspend')
  @HttpCode(200)
  async suspend(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { actor } = await this.auth.operator(req);
    return { subscription: await this.c.subscriptions.suspend(id, parse(this.c.subscriptions.schemas.reason, body).reason, actor), warnings: [] };
  }

  @Post(':id/subscription/cancel')
  @HttpCode(200)
  async cancel(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { actor } = await this.auth.operator(req);
    return { subscription: await this.c.subscriptions.cancel(id, parse(this.c.subscriptions.schemas.reason, body).reason, actor), warnings: [] };
  }

  @Patch(':id/subscription/notes')
  async notes(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { actor } = await this.auth.operator(req);
    return this.c.subscriptions.setNotes(id, parse(this.c.subscriptions.schemas.notes, body).notes, actor);
  }
}

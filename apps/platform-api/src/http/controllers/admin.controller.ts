import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { updatePlanSchema } from '../../modules/plans.service.js';
import { RequestAuth } from '../request-auth.js';
import { CONTAINER } from '../tokens.js';
import { parse } from '../validation.js';

const createOperatorSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(10).max(200).optional(),
});
const statusSchema = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) });
const auditSchema = z.object({ organizationId: z.string().uuid().optional(), beforeId: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const resetSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200) });

@Controller()
export class AdminController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(RequestAuth) private readonly auth: RequestAuth,
  ) {}

  @Get('dashboard')
  async dashboard(@Req() req: Request) {
    await this.auth.operator(req);
    return this.c.dashboard.get();
  }

  // ── Planes ───────────────────────────────────────────────────────────────────
  @Get('plans')
  async plans(@Req() req: Request) {
    await this.auth.operator(req);
    return this.c.plans.list();
  }

  @Patch('plans/:code')
  async updatePlan(@Req() req: Request, @Param('code') code: string, @Body() body: unknown) {
    const { actor } = await this.auth.operator(req);
    return this.c.plans.update(code, parse(updatePlanSchema, body), actor);
  }

  // ── Operadores ───────────────────────────────────────────────────────────────
  @Get('operators')
  async operators(@Req() req: Request) {
    await this.auth.operator(req);
    return this.c.operators.list();
  }

  /** La contraseña inicial (si se generó) se devuelve UNA vez. */
  @Post('operators')
  async createOperator(@Req() req: Request, @Body() body: unknown) {
    const { actor } = await this.auth.operator(req);
    return this.c.operators.create(parse(createOperatorSchema, body), actor);
  }

  @Post('operators/:id/status')
  @HttpCode(200)
  async setOperatorStatus(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { operator } = await this.auth.operator(req);
    return this.c.operators.setStatus(id, parse(statusSchema, body).status, operator);
  }

  @Post('operators/:id/reset-password')
  @HttpCode(200)
  async resetOperatorPassword(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const { operator } = await this.auth.operator(req);
    return this.c.operators.resetPassword(id, operator);
  }

  // ── Bitácora y soporte ───────────────────────────────────────────────────────
  @Get('audit')
  async audit(@Req() req: Request, @Query() q: unknown) {
    await this.auth.operator(req);
    return this.c.audit.list(parse(auditSchema, q));
  }

  @Post('support/reset-user-password')
  @HttpCode(200)
  async resetUserPassword(@Req() req: Request, @Body() body: unknown) {
    const { actor } = await this.auth.operator(req);
    return this.c.support.resetUserPassword(parse(resetSchema, body).email, actor);
  }
}

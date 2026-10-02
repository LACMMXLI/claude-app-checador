import { Body, Controller, Get, Inject, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { RequestAuth } from '../request-auth.js';
import { CONTAINER } from '../tokens.js';
import { parse } from '../validation.js';

const scopeQuery = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('ORGANIZATION') }),
  z.object({ scope: z.literal('BRANCH'), targetId: z.string().uuid() }),
  z.object({ scope: z.literal('EMPLOYEE'), targetId: z.string().uuid() }),
]);
const explainQuery = z.object({ branchId: z.string().uuid().optional(), employeeId: z.string().uuid().optional() });
const putSchema = z.object({
  scope: z.enum(['ORGANIZATION', 'BRANCH', 'EMPLOYEE']),
  targetId: z.string().uuid().nullish(),
  values: z.record(z.string(), z.unknown()),
  reason: z.string().max(500).optional(),
});

/** Políticas: override GUARDADO por nivel y política EFECTIVA con su origen. */
@Controller('policies')
export class PoliciesController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(RequestAuth) private readonly auth: RequestAuth,
  ) {}

  private async admin(req: Request) {
    const t = await this.auth.tenant(req);
    t.access.assert('settings.manage');
    return t;
  }

  @Get('effective')
  async effective(@Req() req: Request, @Query() query: unknown) {
    return this.c.policies.explain((await this.admin(req)).ctx, parse(explainQuery, query));
  }

  @Get('override')
  async override(@Req() req: Request, @Query() query: unknown) {
    const { ctx } = await this.admin(req);
    const q = parse(scopeQuery, query);
    return this.c.policies.getOverride(ctx, q.scope, 'targetId' in q ? q.targetId : null);
  }

  @Put('override')
  async setOverride(@Req() req: Request, @Body() body: unknown) {
    const { ctx } = await this.admin(req);
    const input = parse(putSchema, body);
    const targetId = input.scope === 'ORGANIZATION' ? null : (input.targetId ?? null);
    await this.c.policies.setOverride(ctx, input.scope, targetId, input.values as never, input.reason);
    return this.c.policies.getOverride(ctx, input.scope, targetId);
  }
}

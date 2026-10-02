import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { DomainError } from '../../common/errors.js';
import type { Container } from '../../container.js';
import { RequestAuth } from '../request-auth.js';
import { CONTAINER } from '../tokens.js';
import { parse } from '../validation.js';

const tz = z.string().min(1).max(64);
const createSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), name: z.string().trim().min(1).max(120), timezone: tz.nullish() });
const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timezone: tz.nullable().optional(), // null = vuelve a heredar la zona del negocio
  isActive: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});

@Controller('branches')
export class BranchesController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(RequestAuth) private readonly auth: RequestAuth,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    const { ctx, access } = await this.auth.tenant(req);
    return this.c.branches.list(ctx, access.can('branches.manage') ? 'ALL' : access.visibleBranches());
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const { ctx, access } = await this.auth.tenant(req);
    const visible = access.visibleBranches();
    if (visible !== 'ALL' && !visible.has(id)) throw new DomainError('BRANCH_NOT_FOUND');
    return this.c.branches.get(ctx, id);
  }

  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    access.assert('branches.manage');
    const input = parse(createSchema, body);
    return this.c.branches.create(ctx, input);
  }

  /** Editar y activar/desactivar. No existe borrado físico. */
  @Patch(':id')
  async update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    access.assert('branches.manage', id);
    const { reason, ...patch } = parse(updateSchema, body);
    return this.c.branches.update(ctx, id, patch, reason);
  }
}

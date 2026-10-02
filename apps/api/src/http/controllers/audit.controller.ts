import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { RequestAuth } from '../request-auth.js';
import { CONTAINER } from '../tokens.js';
import { parse } from '../validation.js';

const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  beforeId: z.coerce.number().int().positive().optional(),
  entityType: z.string().max(60).optional(),
  branchId: z.string().uuid().optional(),
  action: z.string().max(80).optional(),
});

@Controller()
export class AuditController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(RequestAuth) private readonly auth: RequestAuth,
  ) {}

  @Get('audit')
  async list(@Req() req: Request, @Query() q: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    access.assert('audit.view');
    return this.c.auditQuery.list(ctx, parse(query, q));
  }

  /** Resumen para el tablero de inicio (solo lo visible para el usuario). */
  @Get('dashboard')
  async dashboard(@Req() req: Request) {
    const { ctx, access } = await this.auth.tenant(req);
    const branchScope = access.can('branches.manage') ? 'ALL' : access.visibleBranches();
    const branches = await this.c.branches.list(ctx, branchScope);
    const employees = access.can('employees.view') ? await this.c.employees.list(ctx, access.branchesFor('employees.view'), { status: 'ACTIVE' }) : [];
    return {
      branches: { total: branches.length, active: branches.filter((b) => b.isActive).length },
      employees: { active: employees.length },
      members: access.can('memberships.manage') ? (await this.c.memberships.list(ctx)).filter((m) => m.status === 'ACTIVE').length : null,
      kiosks: access.can('kiosks.manage') ? (await this.c.kiosks.list(ctx)).length : null,
    };
  }
}

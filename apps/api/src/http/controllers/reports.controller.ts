import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { PERIOD_KEYS, type PeriodKey } from '../../modules/reports/periods.js';
import { REPORT_KINDS, type ReportKind } from '../../modules/reports/reports.service.js';
import { RequestAuth } from '../request-auth.js';
import { CONTAINER } from '../tokens.js';
import { parse } from '../validation.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const filterSchema = z
  .object({
    report: z.enum(REPORT_KINDS as unknown as [ReportKind, ...ReportKind[]]),
    period: z.enum(PERIOD_KEYS as unknown as [PeriodKey, ...PeriodKey[]]).optional(),
    from: date.optional(),
    to: date.optional(),
    branchId: z.string().uuid().optional(),
    employeeId: z.string().uuid().optional(),
  })
  .refine((f) => Boolean(f.period) !== Boolean(f.from || f.to), { message: 'period o from/to' });
const exportSchema = z.object({ format: z.enum(['xlsx', 'csv']), filters: filterSchema });

/**
 * Reportes (D-73) y exportación (D-74). El negocio sale de la sesión; el alcance por sucursal de `reports.view` /
 * `reports.export` se aplica en el servicio y el RLS es la última capa.
 */
@Controller('reports')
export class ReportsController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(RequestAuth) private readonly auth: RequestAuth,
  ) {}

  @Get('periods')
  async periods(@Req() req: Request, @Query() q: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const { branchId } = parse(z.object({ branchId: z.string().uuid().optional() }), q);
    return this.c.reports.periods(ctx, access, branchId);
  }

  @Get('attendance')
  async attendance(@Req() req: Request, @Query() q: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    return this.c.reports.run(ctx, access, parse(filterSchema, q));
  }

  @Post('export')
  @HttpCode(200)
  async export(@Req() req: Request, @Body() body: unknown, @Res() res: Response) {
    const { ctx, access } = await this.auth.tenant(req);
    const input = parse(exportSchema, body);
    const file = await this.c.reports.export(ctx, access, input.filters, input.format);
    res.setHeader('content-type', file.contentType);
    res.setHeader('content-disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-report-rows', String(file.rows));
    res.end(file.body);
  }
}

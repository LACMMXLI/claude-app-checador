import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { DomainError } from '../../common/errors.js';
import type { Container } from '../../container.js';
import { templateEntrySchema } from '../../modules/scheduling/templates.service.js';
import { RequestAuth } from '../request-auth.js';
import { CONTAINER } from '../tokens.js';
import { parse } from '../validation.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const fold = z.enum(['EARLIER', 'LATER']);
const version = z.number().int().positive();

const weekQuery = z.object({ branchId: z.string().uuid(), date });
const ensureSchema = z.object({ branchId: z.string().uuid(), date });
const publishSchema = z.object({ expectedVersion: version });
const copySchema = z.object({ branchId: z.string().uuid(), sourceWeek: date, targetWeek: date.optional(), dryRun: z.boolean().optional() });
const createSchema = z.object({
  branchId: z.string().uuid(),
  employeeId: z.string().uuid(),
  date,
  startTime: time,
  endTime: time,
  startFold: fold.optional(),
  endFold: fold.optional(),
  notes: z.string().max(500).nullish(),
  reason: z.string().max(500).optional(),
  dryRun: z.boolean().optional(),
});
const updateSchema = z.object({
  expectedVersion: version,
  branchId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  date: date.optional(),
  startTime: time.optional(),
  endTime: time.optional(),
  startFold: fold.optional(),
  endFold: fold.optional(),
  notes: z.string().max(500).nullish(),
  reason: z.string().max(500).optional(),
});
const cancelSchema = z.object({ expectedVersion: version, reason: z.string().trim().min(1).max(500) });
const deleteQuery = z.object({ expectedVersion: z.coerce.number().int().positive(), reason: z.string().max(500).optional() });
const templateCreate = z.object({ branchId: z.string().uuid(), name: z.string().trim().min(1).max(80) });
const templatePut = z.object({ expectedVersion: version, name: z.string().trim().min(1).max(80).optional(), isActive: z.boolean().optional(), entries: z.array(templateEntrySchema).max(500) });
const applySchema = z.object({ weekStart: date, dryRun: z.boolean().optional() });

/**
 * Planificación: sesión → negocio → RBAC por sucursal → TenantDb/RLS. Ningún dato de la petición
 * elige el negocio; las reglas (alcance, histórico, DST, traslapes) se aplican en el servicio y en PostgreSQL.
 */
@Controller()
export class SchedulesController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(RequestAuth) private readonly auth: RequestAuth,
  ) {}

  @Get('schedules/week')
  async week(@Req() req: Request, @Query() q: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const input = parse(weekQuery, q);
    return this.c.scheduling.getWeek(ctx, access, input.branchId, input.date);
  }

  /** Crea (o devuelve) el horario semanal en BORRADOR. Los turnos se guardan al momento: no hay "guardar" aparte. */
  @Post('schedules')
  async ensure(@Req() req: Request, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const input = parse(ensureSchema, body);
    return this.c.scheduling.ensureSchedule(ctx, access, input.branchId, input.date);
  }

  @Post('schedules/:id/publish')
  @HttpCode(200)
  async publish(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    return this.c.scheduling.publish(ctx, access, id, parse(publishSchema, body).expectedVersion);
  }

  /** Copiar semana. Con `dryRun: true` devuelve la vista previa de turnos y conflictos sin guardar nada. */
  @Post('schedules/copy')
  @HttpCode(200)
  async copy(@Req() req: Request, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    return this.c.scheduling.copyWeek(ctx, access, parse(copySchema, body));
  }

  @Post('shifts')
  async create(@Req() req: Request, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const { reason, dryRun, ...input } = parse(createSchema, body);
    return this.c.scheduling.createShift(ctx, access, input, { reason, dryRun });
  }

  @Get('shifts/:id')
  async get(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const { ctx, access } = await this.auth.tenant(req);
    return this.c.scheduling.getShift(ctx, access, id);
  }

  /** Historial (auditoría) de un turno, visible para quien puede ver su sucursal. */
  @Get('shifts/:id/history')
  async history(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const { ctx, access } = await this.auth.tenant(req);
    await this.c.scheduling.getShift(ctx, access, id); // 404 si no lo puede ver
    return this.c.auditQuery.list(ctx, { entityType: 'shift', entityId: id, limit: 200 });
  }

  @Patch('shifts/:id')
  async update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const { expectedVersion, reason, ...patch } = parse(updateSchema, body);
    return this.c.scheduling.updateShift(ctx, access, id, expectedVersion, patch, reason);
  }

  @Post('shifts/:id/cancel')
  @HttpCode(200)
  async cancel(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const input = parse(cancelSchema, body);
    return this.c.scheduling.cancelShift(ctx, access, id, input.expectedVersion, input.reason);
  }

  /** Solo en BORRADOR. Un turno de un horario publicado se cancela, nunca se borra. */
  @Delete('shifts/:id')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const input = parse(deleteQuery, q);
    await this.c.scheduling.deleteDraftShift(ctx, access, id, input.expectedVersion, input.reason);
  }

  // ── Plantillas ───────────────────────────────────────────────────────────────
  @Get('schedule-templates')
  async listTemplates(@Req() req: Request, @Query('branchId') branchId?: string) {
    const { ctx, access } = await this.auth.tenant(req);
    await this.c.entitlements.assertFeature(ctx, 'scheduleTemplates'); // D-83: función del plan Avanzado
    if (branchId !== undefined && !z.string().uuid().safeParse(branchId).success) throw new DomainError('VALIDATION_ERROR');
    return this.c.templates.list(ctx, access, branchId);
  }

  @Post('schedule-templates')
  async createTemplate(@Req() req: Request, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    await this.c.entitlements.assertFeature(ctx, 'scheduleTemplates'); // D-83: función del plan Avanzado
    return this.c.templates.create(ctx, access, parse(templateCreate, body));
  }

  @Get('schedule-templates/:id')
  async getTemplate(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const { ctx, access } = await this.auth.tenant(req);
    await this.c.entitlements.assertFeature(ctx, 'scheduleTemplates'); // D-83: función del plan Avanzado
    return this.c.templates.get(ctx, access, id);
  }

  @Put('schedule-templates/:id')
  async putTemplate(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    await this.c.entitlements.assertFeature(ctx, 'scheduleTemplates'); // D-83: función del plan Avanzado
    const input = parse(templatePut, body);
    return this.c.templates.replaceEntries(ctx, access, id, input.expectedVersion, input.entries, { name: input.name, isActive: input.isActive });
  }

  @Post('schedule-templates/:id/apply')
  @HttpCode(200)
  async applyTemplate(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    await this.c.entitlements.assertFeature(ctx, 'scheduleTemplates'); // D-83: función del plan Avanzado
    return this.c.templates.apply(ctx, access, id, parse(applySchema, body));
  }
}

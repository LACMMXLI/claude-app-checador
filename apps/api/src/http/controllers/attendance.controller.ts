import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import type { CorrectionInput } from '../../modules/attendance/corrections.service.js';
import { REQUEST_ACTIONS, type RequestAction } from '../../modules/attendance/correction-requests.service.js';
import { DomainError } from '../../common/errors.js';
import { RequestAuth } from '../request-auth.js';
import { CONTAINER } from '../tokens.js';
import { parse } from '../validation.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const localInstant = z.object({ date, time, fold: z.enum(['EARLIER', 'LATER']).optional() });
const version = z.number().int().positive();
const reason = z.string().max(500);

const boardQuery = z.object({ branchId: z.string().uuid(), date: date.optional() });
const sessionsQuery = z.object({
  branchId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  from: date,
  to: date,
  status: z.enum(['OPEN', 'REVIEW', 'CLOSED']).optional(),
  onlyWithIncidents: z.enum(['true', 'false']).optional(),
});
const historyQuery = z.object({ from: date, to: date });
const incidentsQuery = z.object({
  branchId: z.string().uuid().optional(),
  status: z.enum(['OPEN', 'RESOLVED']).optional(),
  type: z.string().regex(/^[A-Z_]+$/).optional(),
  from: date.optional(),
  to: date.optional(),
});
/** Correcciones = acciones de dominio cerradas (no un "editar cualquier campo"). */
const correctionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('SET_CLOCK_IN'), at: localInstant, expectedVersion: version, reason }),
  z.object({ action: z.literal('SET_CLOCK_OUT'), at: localInstant, expectedVersion: version, reason }),
  z.object({ action: z.literal('SET_BREAK_START'), breakId: z.string().uuid(), at: localInstant, expectedVersion: version, reason }),
  z.object({ action: z.literal('SET_BREAK_END'), breakId: z.string().uuid(), at: localInstant, expectedVersion: version, reason }),
  z.object({ action: z.literal('LINK_SHIFT'), shiftId: z.string().uuid(), expectedVersion: version, reason }),
  z.object({ action: z.literal('UNLINK_SHIFT'), expectedVersion: version, reason }),
  z.object({ action: z.literal('ADD_BREAK'), start: localInstant, end: localInstant, expectedVersion: version, reason }),
]);
const requestsQuery = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  branchId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  from: date.optional(),
  to: date.optional(),
});
const panelRequestSchema = z.object({
  clientRequestId: z.string().uuid(),
  action: z.enum(REQUEST_ACTIONS as unknown as [string, ...string[]]),
  workSessionId: z.string().uuid().nullish(),
  breakId: z.string().uuid().nullish(),
  shiftId: z.string().uuid().nullish(),
  branchId: z.string().uuid().nullish(),
  start: localInstant,
  end: localInstant.nullish(),
  reason: z.string().max(500),
});
const approveSchema = z.object({ expectedVersion: version, expectedSessionVersion: version.nullish() });
const rejectSchema = z.object({ expectedVersion: version, reason });
const createSessionSchema = z.object({
  employeeId: z.string().uuid(),
  branchId: z.string().uuid(),
  shiftId: z.string().uuid().nullish(),
  incidentId: z.string().uuid().nullish(),
  start: localInstant,
  end: localInstant,
  reason,
});
const resolveSchema = z.object({ resolution: z.enum(['JUSTIFIED', 'CONFIRMED', 'DISMISSED']), expectedVersion: version, reason });

/**
 * Asistencia en el panel: tablero en vivo, jornadas, detalle, historial, incidencias y correcciones.
 * El negocio sale de la sesión; el alcance por sucursal y "no corregir la propia jornada" se validan en el
 * servicio y el RLS de PostgreSQL es la última capa. La reconciliación NO se expone por HTTP (comando interno).
 */
@Controller('attendance')
export class AttendanceController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(RequestAuth) private readonly auth: RequestAuth,
  ) {}

  /** D-78: día operativo de "hoy" (sucursal o negocio) para los filtros del panel. */
  @Get('today')
  async today(@Req() req: Request, @Query() q: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const { branchId } = parse(z.object({ branchId: z.string().uuid().optional() }), q);
    return this.c.attendanceQuery.today(ctx, access, branchId);
  }

  @Get('board')
  async board(@Req() req: Request, @Query() q: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const input = parse(boardQuery, q);
    return this.c.attendanceQuery.board(ctx, access, input.branchId, input.date);
  }

  @Get('sessions')
  async sessions(@Req() req: Request, @Query() q: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const input = parse(sessionsQuery, q);
    return this.c.attendanceQuery.listSessions(ctx, access, { ...input, onlyWithIncidents: input.onlyWithIncidents === 'true' });
  }

  @Get('sessions/:id')
  async session(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const { ctx, access } = await this.auth.tenant(req);
    return this.c.attendanceQuery.sessionDetail(ctx, access, id);
  }

  @Post('sessions/:id/corrections')
  @HttpCode(200)
  async correct(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const { expectedVersion, reason: why, ...rest } = parse(correctionSchema, body);
    return this.c.corrections.apply(ctx, access, id, expectedVersion, rest as CorrectionInput, why);
  }

  /** D-53: crear por corrección la jornada que sí ocurrió (p. ej. un turno marcado con FALTA). */
  @Post('sessions')
  async createSession(@Req() req: Request, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const { reason: why, ...input } = parse(createSessionSchema, body);
    return this.c.corrections.createSession(ctx, access, input, why);
  }

  @Get('employees/:id/history')
  async history(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const input = parse(historyQuery, q);
    return this.c.attendanceQuery.employeeHistory(ctx, access, id, input.from, input.to);
  }

  @Get('incidents')
  async incidents(@Req() req: Request, @Query() q: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    return this.c.attendanceQuery.listIncidents(ctx, access, parse(incidentsQuery, q));
  }

  @Post('incidents/:id/resolve')
  @HttpCode(200)
  async resolve(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const input = parse(resolveSchema, body);
    return this.c.corrections.resolveIncident(ctx, access, id, input.expectedVersion, input.resolution, input.reason);
  }

  // ── solicitudes de corrección (D-70, D-71) ──────────────────────────────────
  @Get('correction-requests')
  async requests(@Req() req: Request, @Query() q: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    return this.c.correctionRequests.list(ctx, access, parse(requestsQuery, q));
  }

  @Get('correction-requests/summary')
  async requestsSummary(@Req() req: Request) {
    const { ctx, access } = await this.auth.tenant(req);
    return this.c.correctionRequests.pendingCount(ctx, access);
  }

  @Get('correction-requests/:id')
  async request(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const { ctx, access } = await this.auth.tenant(req);
    return this.c.correctionRequests.get(ctx, access, id);
  }

  /** Panel: solo quien tiene cuenta CON ficha de empleado, y solo sobre su propia ficha (decisión 1). */
  @Post('correction-requests')
  async createRequest(@Req() req: Request, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    if (!access.employeeId) throw new DomainError('NO_EMPLOYEE_RECORD');
    if (!access.can('attendance.correction.request')) throw new DomainError('FORBIDDEN', { permission: 'attendance.correction.request' });
    const input = parse(panelRequestSchema, body);
    return this.c.correctionRequests.create(ctx, { channel: 'PANEL', userId: ctx.actor.userId! }, access.employeeId, { ...input, action: input.action as RequestAction });
  }

  @Post('correction-requests/:id/cancel')
  @HttpCode(200)
  async cancelRequest(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const { ctx, access } = await this.auth.tenant(req);
    if (!access.employeeId) throw new DomainError('REQUEST_NOT_FOUND');
    return this.c.correctionRequests.cancel(ctx, { channel: 'PANEL', userId: ctx.actor.userId! }, access.employeeId, id);
  }

  @Post('correction-requests/:id/approve')
  @HttpCode(200)
  async approve(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const input = parse(approveSchema, body);
    return this.c.correctionRequests.approve(ctx, access, id, input.expectedVersion, input.expectedSessionVersion ?? null);
  }

  @Post('correction-requests/:id/reject')
  @HttpCode(200)
  async reject(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const input = parse(rejectSchema, body);
    return this.c.correctionRequests.reject(ctx, access, id, input.expectedVersion, input.reason);
  }

  /** "Mis jornadas" (panel): la propia ficha, ventana de solicitud. */
  @Get('my/sessions')
  async mySessions(@Req() req: Request, @Query() q: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    if (!access.employeeId) throw new DomainError('NO_EMPLOYEE_RECORD');
    const { branchId } = parse(z.object({ branchId: z.string().uuid() }), q);
    return this.c.correctionRequests.ownRecords(ctx, access.employeeId, branchId);
  }
}

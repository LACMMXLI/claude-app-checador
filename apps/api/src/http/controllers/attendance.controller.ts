import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import type { CorrectionInput } from '../../modules/attendance/corrections.service.js';
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
]);
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
}

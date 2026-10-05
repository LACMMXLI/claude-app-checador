import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { DomainError } from '../../common/errors.js';
import type { Container } from '../../container.js';
import type { AccessProfile } from '../../modules/auth/rbac.service.js';
import { RequestAuth } from '../request-auth.js';
import { CONTAINER } from '../tokens.js';
import { parse } from '../validation.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const restDays = z.array(z.number().int().min(1).max(7)).max(6);
const birthDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => { const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }, 'fecha inexistente');
const createSchema = z.object({
  employeeNumber: z.string().trim().min(1).max(40),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(40).optional(),
  primaryBranchId: z.string().uuid(),
  hiredAt: date.optional(),
  restDays: restDays.optional(),
  birthDate: birthDate.nullish(),
});
const updateSchema = z.object({
  employeeNumber: z.string().trim().min(1).max(40).optional(),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  restDays: restDays.optional(),
  birthDate: birthDate.nullable().optional(),
  reason: z.string().max(500).optional(),
});
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(500) });
const optionalReason = z.object({ reason: z.string().max(500).optional() });
const assignSchema = z.object({
  branchId: z.string().uuid(),
  kind: z.enum(['PRIMARY', 'TEMPORARY']),
  validFrom: date,
  validTo: date.nullish(),
  reason: z.string().max(500).optional(),
});
const listQuery = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']).optional(), branchId: z.string().uuid().optional() });

@Controller('employees')
export class EmployeesController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(RequestAuth) private readonly auth: RequestAuth,
  ) {}

  /** Empleado visible si tiene asignación vigente en el alcance; si no, 404 (no se revela su existencia). */
  private async loadVisible(req: Request, id: string) {
    const t = await this.auth.tenant(req);
    t.access.assert('employees.view');
    const employee = await this.c.employees.get(t.ctx, id);
    const scope = t.access.branchesFor('employees.view');
    if (scope !== 'ALL' && !employee.branchIds.some((b) => scope.has(b))) throw new DomainError('EMPLOYEE_NOT_FOUND');
    return { ...t, employee };
  }

  /** Administrar a un empleado exige el permiso en su sucursal PRINCIPAL vigente. */
  private assertManage(access: AccessProfile, permission: string, employee: { primaryBranchId: string | null }) {
    if (employee.primaryBranchId ? !access.can(permission, employee.primaryBranchId) : access.branchesFor(permission) !== 'ALL') {
      throw new DomainError('FORBIDDEN', { permission });
    }
  }

  @Get()
  async list(@Req() req: Request, @Query() query: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    access.assert('employees.view');
    return this.c.employees.list(ctx, access.branchesFor('employees.view'), parse(listQuery, query));
  }

  /** Próximos turnos del empleado (solo de sucursales visibles para el usuario). */
  @Get(':id/shifts')
  async shifts(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown) {
    const { ctx, access } = await this.loadVisible(req, id);
    const input = parse(z.object({ from: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), q);
    return this.c.scheduling.employeeShifts(ctx, access, id, { from: input.from ? new Date(input.from) : undefined, limit: input.limit });
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return (await this.loadVisible(req, id)).employee;
  }

  /** Alta: devuelve el PIN generado UNA sola vez. */
  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    const { ctx, access } = await this.auth.tenant(req);
    const input = parse(createSchema, body);
    access.assert('employees.manage', input.primaryBranchId);
    return this.c.employees.create(ctx, input);
  }

  @Patch(':id')
  async update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access, employee } = await this.loadVisible(req, id);
    this.assertManage(access, 'employees.manage', employee);
    const { reason, ...patch } = parse(updateSchema, body);
    return this.c.employees.update(ctx, id, patch, reason);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  async deactivate(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access, employee } = await this.loadVisible(req, id);
    this.assertManage(access, 'employees.manage', employee);
    return this.c.employees.deactivate(ctx, id, parse(reasonSchema, body).reason);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  async reactivate(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access, employee } = await this.loadVisible(req, id);
    this.assertManage(access, 'employees.manage', employee);
    return this.c.employees.reactivate(ctx, id, parse(optionalReason, body).reason);
  }

  /** Genera/restablece el PIN: el anterior deja de funcionar al instante; el nuevo se muestra una vez. */
  @Post(':id/pin')
  @HttpCode(200)
  async resetPin(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access, employee } = await this.loadVisible(req, id);
    this.assertManage(access, 'employees.pin.manage', employee);
    return this.c.employees.resetPin(ctx, id, parse(optionalReason, body).reason);
  }

  @Post(':id/assignments')
  async assign(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { ctx, access, employee } = await this.loadVisible(req, id);
    const input = parse(assignSchema, body);
    this.assertManage(access, 'employees.manage', employee);
    access.assert('employees.manage', input.branchId); // también sobre la sucursal destino
    return this.c.employees.assignBranch(ctx, id, input);
  }
}

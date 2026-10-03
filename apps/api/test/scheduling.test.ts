import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schedFixture, type SchedFixture } from './helpers/scheduling-fixture.js';
import { pgError } from './helpers/sql.js';
import { buildWorld, openPools } from './helpers/world.js';

const pools = openPools();
let now = new Date('2026-10-01T12:00:00Z'); // jueves 1-oct-2026; las semanas de prueba son futuras
const world = buildWorld(pools, { clock: () => now });
const S = world.scheduling;
let F: SchedFixture;

beforeAll(async () => {
  F = await schedFixture(world);
});
beforeEach(() => {
  now = new Date('2026-10-01T12:00:00Z');
});
afterAll(() => pools.close());

const shift = (employeeId: string, branchId: string, date: string, startTime: string, endTime: string) => ({ employeeId, branchId, date, startTime, endTime });
const row = async (id: string) => (await pools.platform.query(`SELECT * FROM scheduling.shifts WHERE id = $1`, [id])).rows[0];
const audits = async (entityId: string) =>
  (await pools.platform.query(`SELECT * FROM audit.audit_log WHERE organization_id = $1 AND entity_id = $2 ORDER BY id`, [F.orgId, entityId])).rows;

describe('crear turnos', () => {
  it('(1)(2)(3) turno normal y nocturno; el nocturno conserva ambas fechas y su zona', async () => {
    const day = await S.createShift(F.ctx, F.admin, shift(F.maria, F.VEN, '2026-10-05', '07:00', '15:00'));
    expect(day).toMatchObject({ businessDate: '2026-10-05', startTime: '07:00', endTime: '15:00', crossesMidnight: false, scheduledMinutes: 480, status: 'SCHEDULED', scheduleStatus: 'DRAFT' });

    const night = await S.createShift(F.ctx, F.admin, shift(F.carlos, F.VEN, '2026-10-05', '19:00', '03:00'));
    expect(night).toMatchObject({ businessDate: '2026-10-05', startDate: '2026-10-05', startTime: '19:00', endDate: '2026-10-06', endTime: '03:00', crossesMidnight: true, scheduledMinutes: 480, timezone: 'America/Tijuana' });
    const db = await row(night.id);
    expect(db.starts_at.toISOString()).toBe('2026-10-06T02:00:00.000Z');
    expect(db.ends_at.toISOString()).toBe('2026-10-06T10:00:00.000Z');
    expect(db).toMatchObject({ timezone_snapshot: 'America/Tijuana', scheduled_minutes: 480 }); // sin descontar comida
    expect((await audits(night.id)).map((a) => a.action)).toEqual(['shift.created']);
  });

  it('(5)(6)(7) DST: hora inexistente ⇒ error; ambigua ⇒ exige elegir y se resuelve explícitamente', async () => {
    await expect(S.createShift(F.ctx, F.admin, shift(F.maria, F.VEN, '2027-03-14', '02:30', '10:00'))).rejects.toMatchObject({ code: 'LOCAL_TIME_NONEXISTENT' });
    await expect(S.createShift(F.ctx, F.admin, shift(F.maria, F.VEN, '2026-11-01', '01:30', '09:30'))).rejects.toMatchObject({ code: 'LOCAL_TIME_AMBIGUOUS' });
    const later = await S.createShift(F.ctx, F.admin, { ...shift(F.maria, F.VEN, '2026-11-01', '01:30', '09:30'), startFold: 'LATER' });
    expect(later.startsAt.toISOString()).toBe('2026-11-01T09:30:00.000Z');
    expect(later.scheduledMinutes).toBe(480);
    const crossing = await S.createShift(F.ctx, F.admin, shift(F.carlos, F.VEN, '2026-10-31', '22:00', '06:00'));
    expect(crossing.scheduledMinutes).toBe(540); // la noche del cambio de horario dura una hora más
  });

  it('(8) PostgreSQL rechaza ends_at <= starts_at aunque se salte la aplicación', async () => {
    const c = await pools.platform.connect();
    try {
      await c.query('BEGIN');
      const sch = (await c.query(`SELECT id FROM scheduling.weekly_schedules WHERE organization_id = $1 AND branch_id = $2 LIMIT 1`, [F.orgId, F.VEN])).rows[0].id;
      const err = await pgError(c, `INSERT INTO scheduling.shifts (organization_id, schedule_id, branch_id, employee_id, business_date, operational_date, starts_at, ends_at, timezone_snapshot)
        VALUES ($1, $2, $3, $4, '2026-10-07', '2026-10-07', '2026-10-07T10:00Z', '2026-10-07T10:00Z', 'America/Tijuana')`, [F.orgId, sch, F.VEN, F.maria]);
      expect(err?.code).toBe('23514');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('duración fuera de la política (1–16 h por defecto) se rechaza', async () => {
    await expect(S.createShift(F.ctx, F.admin, shift(F.maria, F.VEN, '2026-10-08', '07:00', '07:30'))).rejects.toMatchObject({ code: 'SHIFT_DURATION_INVALID' });
    await expect(S.createShift(F.ctx, F.admin, shift(F.maria, F.VEN, '2026-10-08', '07:00', '06:00'))).rejects.toMatchObject({ code: 'SHIFT_DURATION_INVALID' });
  });
});

describe('traslapes (D-29)', () => {
  it('(9)(10)(11)(12) mismo empleado: rechaza traslape (también entre sucursales), permite consecutivos y libera al cancelar', async () => {
    await world.employees.assignBranch(F.ctx, F.pedro, { branchId: F.VEN, kind: 'TEMPORARY', validFrom: '2026-10-12', validTo: '2026-10-18', reason: 'Cubre Venecia' });
    const ven = await S.createShift(F.ctx, F.admin, shift(F.pedro, F.VEN, '2026-10-12', '19:00', '03:00'));
    await expect(S.createShift(F.ctx, F.admin, shift(F.pedro, F.VEN, '2026-10-12', '20:00', '23:00'))).rejects.toMatchObject({ code: 'SHIFT_OVERLAP' });
    const cross = await S.createShift(F.ctx, F.admin, shift(F.pedro, F.SMA, '2026-10-12', '22:00', '06:00')).catch((e) => e);
    expect(cross.code).toBe('SHIFT_OVERLAP'); // Venecia 19–03 vs San Marcos 22–06
    expect(cross.details.conflicts[0]).toMatchObject({ shiftId: ven.id, branchId: F.VEN });

    // consecutivos [inicio, fin): 07–15 y 15–23
    const a = await S.createShift(F.ctx, F.admin, shift(F.pedro, F.SMA, '2026-10-14', '07:00', '15:00'));
    const b = await S.createShift(F.ctx, F.admin, shift(F.pedro, F.SMA, '2026-10-14', '15:00', '23:00'));
    expect([a.status, b.status]).toEqual(['SCHEDULED', 'SCHEDULED']);

    // cancelar libera el espacio
    await S.cancelShift(F.ctx, F.admin, ven.id, ven.version, 'Ya no cubre');
    await expect(S.createShift(F.ctx, F.admin, shift(F.pedro, F.SMA, '2026-10-12', '22:00', '06:00'))).resolves.toMatchObject({ status: 'SCHEDULED' });
  });

  it('la restricción de exclusión de PostgreSQL bloquea el traslape aunque la aplicación no lo valide', async () => {
    const s1 = await S.createShift(F.ctx, F.admin, shift(F.maria, F.VEN, '2026-10-20', '07:00', '15:00'));
    const c = await pools.platform.connect();
    try {
      await c.query('BEGIN');
      const err = await pgError(c, `INSERT INTO scheduling.shifts (organization_id, schedule_id, branch_id, employee_id, business_date, operational_date, starts_at, ends_at, timezone_snapshot)
        SELECT organization_id, schedule_id, branch_id, employee_id, business_date, operational_date, starts_at + interval '1 hour', ends_at + interval '1 hour', timezone_snapshot FROM scheduling.shifts WHERE id = $1`, [s1.id]);
      expect(err?.code).toBe('23P01');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});

describe('alcance del encargado (D-30)', () => {
  it('(13)(14)(15) encargado: solo su sucursal y solo empleados asignados a ella; admin: cualquiera', async () => {
    await expect(S.createShift(F.managerCtx, F.manager, shift(F.pedro, F.SMA, '2026-10-21', '07:00', '15:00'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Pedro (San Marcos) sin asignación a Venecia esa fecha: la planificación es estricta
    await expect(S.createShift(F.managerCtx, F.manager, shift(F.pedro, F.VEN, '2026-10-21', '07:00', '15:00'))).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_ASSIGNED_TO_BRANCH' });
    const own = await S.createShift(F.managerCtx, F.manager, shift(F.carlos, F.VEN, '2026-10-21', '19:00', '03:00'));
    expect(own.branchId).toBe(F.VEN);
    await expect(S.createShift(F.ctx, F.admin, shift(F.pedro, F.SMA, '2026-10-21', '07:00', '15:00'))).resolves.toMatchObject({ branchId: F.SMA });
    // el encargado no ve ni modifica turnos de San Marcos
    const sma = await S.createShift(F.ctx, F.admin, shift(F.pedro, F.SMA, '2026-10-22', '07:00', '15:00'));
    await expect(S.getShift(F.managerCtx, F.manager, sma.id)).rejects.toMatchObject({ code: 'SHIFT_NOT_FOUND' });
    await expect(S.cancelShift(F.managerCtx, F.manager, sma.id, sma.version, 'x')).rejects.toMatchObject({ code: 'SHIFT_NOT_FOUND' });
    await expect(S.updateShift(F.managerCtx, F.manager, own.id, own.version, { branchId: F.SMA })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('horario semanal: borrador, publicación, cambios y cancelación (D-24, D-31)', () => {
  it('(31)(26)(27)(28) publicar lo hace oficial; editar y cancelar publicados se audita y conserva el registro', async () => {
    const s1 = await S.createShift(F.ctx, F.admin, shift(F.maria, F.VEN, '2026-11-09', '07:00', '15:00'));
    const week = await S.getWeek(F.ctx, F.admin, F.VEN, '2026-11-11');
    expect(week).toMatchObject({ weekStart: '2026-11-09', schedule: { status: 'DRAFT' } });
    expect(week.days).toHaveLength(7);
    const published = await S.publish(F.ctx, F.admin, week.schedule!.id, week.schedule!.version);
    expect(published.status).toBe('PUBLISHED');
    await expect(S.publish(F.ctx, F.admin, week.schedule!.id, published.version)).rejects.toMatchObject({ code: 'SCHEDULE_ALREADY_PUBLISHED' });
    expect((await S.getShift(F.ctx, F.admin, s1.id)).scheduleStatus).toBe('PUBLISHED');

    const edited = await S.updateShift(F.ctx, F.admin, s1.id, s1.version, { startTime: '08:00', endTime: '16:00' });
    expect(edited).toMatchObject({ startTime: '08:00', endTime: '16:00', version: s1.version + 1 });
    const upd = (await audits(s1.id)).find((a) => a.action === 'shift.updated')!;
    expect(upd).toMatchObject({ organization_id: F.orgId, branch_id: F.VEN, actor_user_id: F.ctx.actor.userId });
    expect([upd.before.startTime, upd.after.startTime]).toEqual(['07:00', '08:00']);

    await expect(S.cancelShift(F.ctx, F.admin, s1.id, edited.version, '  ')).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    await expect(S.deleteDraftShift(F.ctx, F.admin, s1.id, edited.version)).rejects.toMatchObject({ code: 'SHIFT_PUBLISHED_USE_CANCEL' });
    const cancelled = await S.cancelShift(F.ctx, F.admin, s1.id, edited.version, 'Cambio de rol');
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Cambio de rol' });
    expect(await row(s1.id)).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Cambio de rol' }); // el registro sigue ahí
    await expect(S.updateShift(F.ctx, F.admin, s1.id, cancelled.version, { notes: 'x' })).rejects.toMatchObject({ code: 'SHIFT_CANCELLED' });
    expect((await audits(s1.id)).map((a) => a.action)).toEqual(['shift.created', 'shift.updated', 'shift.cancelled']);
    const pub = (await pools.platform.query(`SELECT * FROM audit.audit_log WHERE entity_id = $1 AND action = 'schedule.published'`, [week.schedule!.id])).rows[0];
    expect(pub.after).toMatchObject({ status: 'PUBLISHED', shifts: 1 });
  });

  it('la BD impide borrar un turno publicado, revivir uno cancelado y despublicar un horario', async () => {
    const id = (await pools.platform.query(`SELECT s.id FROM scheduling.shifts s JOIN scheduling.weekly_schedules w ON w.id = s.schedule_id WHERE w.status = 'PUBLISHED' AND s.organization_id = $1 LIMIT 1`, [F.orgId])).rows[0].id;
    const c = await pools.migrator.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.organization_id', $1, true)`, [F.orgId]);
      await c.query(`GRANT DELETE ON scheduling.shifts TO migrator`).catch(() => undefined);
      expect((await pgError(c, `DELETE FROM scheduling.shifts WHERE id = $1`, [id]))?.code).toBe('23001');
      expect((await pgError(c, `UPDATE scheduling.shifts SET status = 'SCHEDULED', cancelled_at = NULL, cancel_reason = NULL WHERE id = $1`, [id]))?.code).toBe('23001');
      expect((await pgError(c, `UPDATE scheduling.weekly_schedules SET status = 'DRAFT', published_at = NULL WHERE status = 'PUBLISHED'`))?.code).toBe('23001');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('en BORRADOR se puede quitar un turno (auditado)', async () => {
    const s = await S.createShift(F.ctx, F.admin, shift(F.maria, F.VEN, '2026-11-16', '07:00', '15:00'));
    await S.deleteDraftShift(F.ctx, F.admin, s.id, s.version);
    expect(await row(s.id)).toBeUndefined();
    expect((await audits(s.id)).map((a) => a.action)).toEqual(['shift.created', 'shift.deleted_from_draft']);
  });
});

describe('turnos históricos (D-32)', () => {
  it('(29)(30) encargado no altera un turno terminado ni en curso; admin sí, con motivo obligatorio', async () => {
    const s = await S.createShift(F.managerCtx, F.manager, shift(F.carlos, F.VEN, '2026-10-07', '19:00', '03:00'));
    now = new Date('2026-10-08T03:00:00Z'); // en curso
    await expect(S.updateShift(F.managerCtx, F.manager, s.id, s.version, { endTime: '02:00' })).rejects.toMatchObject({ code: 'SHIFT_HISTORY_LOCKED' });
    now = new Date('2026-10-09T12:00:00Z'); // terminado
    await expect(S.updateShift(F.managerCtx, F.manager, s.id, s.version, { startTime: '19:30' })).rejects.toMatchObject({ code: 'SHIFT_HISTORY_LOCKED' });
    await expect(S.cancelShift(F.managerCtx, F.manager, s.id, s.version, 'no vino')).rejects.toMatchObject({ code: 'SHIFT_HISTORY_LOCKED' });
    await expect(S.updateShift(F.ctx, F.admin, s.id, s.version, { startTime: '19:30' })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    const fixed = await S.updateShift(F.ctx, F.admin, s.id, s.version, { startTime: '19:30' }, 'Error de captura en la planificación');
    expect(fixed.startTime).toBe('19:30');
    const a = (await audits(s.id)).at(-1)!;
    expect(a).toMatchObject({ action: 'shift.history_corrected', reason: 'Error de captura en la planificación' });
    // tampoco se crean turnos en el pasado sin ese permiso
    await expect(S.createShift(F.managerCtx, F.manager, shift(F.maria, F.VEN, '2026-10-08', '07:00', '15:00'))).rejects.toMatchObject({ code: 'SHIFT_HISTORY_LOCKED' });
  });
});

describe('zona horaria del turno (D-26)', () => {
  it('(24)(25) cambiar la zona de la sucursal no reinterpreta turnos existentes; los nuevos usan la nueva', async () => {
    const before = await S.createShift(F.ctx, F.admin, shift(F.pedro, F.SMA, '2026-12-01', '19:00', '03:00'));
    await world.branches.update(F.ctx, F.SMA, { timezone: 'America/Mexico_City' });
    try {
      const again = await S.getShift(F.ctx, F.admin, before.id);
      expect(again).toMatchObject({ timezone: 'America/Tijuana', startTime: '19:00', endTime: '03:00' });
      expect(again.startsAt.toISOString()).toBe(before.startsAt.toISOString());
      const after = await S.createShift(F.ctx, F.admin, shift(F.pedro, F.SMA, '2026-12-02', '19:00', '03:00'));
      expect(after).toMatchObject({ timezone: 'America/Mexico_City', startTime: '19:00' });
      expect(after.startsAt.toISOString()).toBe('2026-12-03T01:00:00.000Z'); // 19:00 CST (−6)
    } finally {
      await world.branches.update(F.ctx, F.SMA, { timezone: null });
    }
  });
});

describe('copiar semana', () => {
  it('(19)(21)(22) conserva horas locales, reporta conflictos (traslape, empleado inactivo) y no duplica', async () => {
    // Semana origen 2026-10-26 (lun) … 2026-11-01 (dom): incluye el cambio de horario
    await S.createShift(F.ctx, F.admin, shift(F.carlos, F.VEN, '2026-10-26', '19:00', '03:00'));
    await S.createShift(F.ctx, F.admin, shift(F.maria, F.VEN, '2026-10-27', '07:00', '15:00'));
    const extra = await world.employees.create(F.ctx, { employeeNumber: 'X-9', firstName: 'Temporal', primaryBranchId: F.VEN, hiredAt: '2026-01-01' });
    await S.createShift(F.ctx, F.admin, shift(extra.employee.id, F.VEN, '2026-10-28', '07:00', '15:00'));
    await world.employees.deactivate(F.ctx, extra.employee.id, 'Baja');
    // María ya tiene un turno en San Marcos que choca con su copia del martes 3-nov
    await world.employees.assignBranch(F.ctx, F.maria, { branchId: F.SMA, kind: 'TEMPORARY', validFrom: '2026-11-03', validTo: '2026-11-03', reason: 'Apoyo' });
    await S.createShift(F.ctx, F.admin, shift(F.maria, F.SMA, '2026-11-03', '10:00', '18:00'));

    const preview = await S.copyWeek(F.ctx, F.admin, { branchId: F.VEN, sourceWeek: '2026-10-26', dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect((await pools.platform.query(`SELECT count(*)::int AS n FROM scheduling.shifts WHERE organization_id = $1 AND business_date BETWEEN '2026-11-02' AND '2026-11-08' AND branch_id = $2`, [F.orgId, F.VEN])).rows[0].n).toBe(0);

    const result = await S.copyWeek(F.ctx, F.admin, { branchId: F.VEN, sourceWeek: '2026-10-28' }); // cualquier día de la semana origen
    expect(result.weekStart).toBe('2026-11-02');
    expect(result.conflicts.map((c) => [c.date, c.code]).sort()).toEqual([['2026-11-03', 'SHIFT_OVERLAP'], ['2026-11-04', 'EMPLOYEE_INACTIVE']]);
    expect(preview.conflicts.map((c) => c.code).sort()).toEqual(result.conflicts.map((c) => c.code).sort());
    const carlos = result.created.find((s) => s.employeeId === F.carlos)!;
    // misma hora LOCAL (19:00 → 03:00) aunque el offset cambió de −7 a −8: no se sumaron 7×24 h en UTC
    expect(carlos).toMatchObject({ businessDate: '2026-11-02', startTime: '19:00', endTime: '03:00', endDate: '2026-11-03', source: 'COPY' });
    expect(carlos.startsAt.toISOString()).toBe('2026-11-03T03:00:00.000Z');
    const source = (await pools.platform.query(`SELECT starts_at FROM scheduling.shifts WHERE id = $1`, [carlos.sourceShiftId])).rows[0].starts_at as Date;
    expect(carlos.startsAt.getTime() - source.getTime()).toBe(7 * 24 * 3600_000 + 3600_000);

    // idempotente: volver a copiar no duplica
    const again = await S.copyWeek(F.ctx, F.admin, { branchId: F.VEN, sourceWeek: '2026-10-26' });
    expect(again.created).toHaveLength(0);
    expect(again.conflicts.filter((c) => c.code === 'ALREADY_COPIED').length).toBe(result.created.length);
    const audit = (await pools.platform.query(`SELECT * FROM audit.audit_log WHERE organization_id = $1 AND action = 'schedule.week_copied' ORDER BY id`, [F.orgId])).rows;
    expect(audit.at(-2).after).toMatchObject({ weekStart: '2026-11-02', sourceWeekStart: '2026-10-26', created: result.created.length });
    expect(audit.at(-2).after.createdShiftIds).toEqual(result.created.map((x) => x.id));
  });

  it('(20) alrededor del DST de primavera: la hora local se conserva y si no existe se informa', async () => {
    await S.createShift(F.ctx, F.admin, shift(F.maria, F.VEN, '2027-03-01', '07:00', '15:00'));
    await S.createShift(F.ctx, F.admin, shift(F.carlos, F.VEN, '2027-03-07', '02:30', '10:30')); // existe el 7-mar
    const r = await S.copyWeek(F.ctx, F.admin, { branchId: F.VEN, sourceWeek: '2027-03-01' });
    expect(r.created.map((s) => [s.businessDate, s.startTime])).toEqual([['2027-03-08', '07:00']]);
    expect(r.conflicts).toEqual([expect.objectContaining({ date: '2027-03-14', startTime: '02:30', code: 'LOCAL_TIME_NONEXISTENT' })]);
  });

  it('(23) copiar a una sucursal desactivada se rechaza con un error claro; destino publicado también', async () => {
    await world.branches.update(F.ctx, F.SMA, { isActive: false });
    try {
      await expect(S.copyWeek(F.ctx, F.admin, { branchId: F.SMA, sourceWeek: '2026-10-12' })).rejects.toMatchObject({ code: 'BRANCH_INACTIVE' });
    } finally {
      await world.branches.update(F.ctx, F.SMA, { isActive: true });
    }
    const wk = await S.getWeek(F.ctx, F.admin, F.VEN, '2026-11-09'); // publicada antes
    expect(wk.schedule?.status).toBe('PUBLISHED');
    await expect(S.copyWeek(F.ctx, F.admin, { branchId: F.VEN, sourceWeek: '2026-11-02', targetWeek: '2026-11-09' })).rejects.toMatchObject({ code: 'SCHEDULE_NOT_DRAFT' });
  });
});

describe('plantillas (D-23)', () => {
  it('(32)(33) aplicar genera turnos; modificar la plantilla NO toca turnos existentes ni publicados', async () => {
    const t = await world.templates.create(F.ctx, F.admin, { branchId: F.VEN, name: 'Noche Carlos' });
    const v1 = await world.templates.replaceEntries(F.ctx, F.admin, t.id, t.version, [
      { employeeId: F.carlos, weekday: 1, startTime: '19:00', endTime: '03:00' },
      { employeeId: F.carlos, weekday: 2, startTime: '19:00', endTime: '03:00' },
      { employeeId: F.carlos, weekday: 4, startTime: '19:00', endTime: '03:00' },
    ]);
    const applied = await world.templates.apply(F.ctx, F.admin, t.id, { weekStart: '2026-11-30' });
    expect(applied.created.map((s) => [s.businessDate, s.startTime, s.endTime])).toEqual([
      ['2026-11-30', '19:00', '03:00'], ['2026-12-01', '19:00', '03:00'], ['2026-12-03', '19:00', '03:00'],
    ]);
    const wk = await S.getWeek(F.ctx, F.admin, F.VEN, '2026-11-30');
    await S.publish(F.ctx, F.admin, wk.schedule!.id, wk.schedule!.version);
    const snapshot = (await pools.platform.query(`SELECT id, starts_at, ends_at, version FROM scheduling.shifts WHERE schedule_id = $1 ORDER BY starts_at`, [wk.schedule!.id])).rows;

    await world.templates.replaceEntries(F.ctx, F.admin, t.id, v1.version, [{ employeeId: F.carlos, weekday: 1, startTime: '07:00', endTime: '15:00' }]);
    expect((await pools.platform.query(`SELECT id, starts_at, ends_at, version FROM scheduling.shifts WHERE schedule_id = $1 ORDER BY starts_at`, [wk.schedule!.id])).rows).toEqual(snapshot);
    await expect(world.templates.replaceEntries(F.ctx, F.admin, t.id, v1.version, [])).rejects.toMatchObject({ code: 'TEMPLATE_VERSION_CONFLICT' });
    await expect(world.templates.apply(F.ctx, F.admin, t.id, { weekStart: '2026-11-30' })).rejects.toMatchObject({ code: 'SCHEDULE_NOT_DRAFT' });
  });
});

describe('concurrencia optimista', () => {
  it('(34) dos usuarios con la misma versión: el segundo recibe conflicto, nada se sobrescribe en silencio', async () => {
    const s = await S.createShift(F.ctx, F.admin, shift(F.maria, F.VEN, '2026-12-14', '07:00', '15:00'));
    const results = await Promise.allSettled([
      S.updateShift(F.ctx, F.admin, s.id, s.version, { startTime: '08:00', endTime: '16:00' }),
      S.updateShift(F.managerCtx, F.manager, s.id, s.version, { notes: 'llega tarde' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'SHIFT_VERSION_CONFLICT' } });
    expect((await row(s.id)).version).toBe(s.version + 1);

    // publicar con una versión vieja del horario (alguien agregó un turno después) ⇒ conflicto
    const wk = await S.getWeek(F.ctx, F.admin, F.VEN, '2026-12-14');
    await S.createShift(F.managerCtx, F.manager, shift(F.carlos, F.VEN, '2026-12-15', '19:00', '03:00'));
    await expect(S.publish(F.ctx, F.admin, wk.schedule!.id, wk.schedule!.version)).rejects.toMatchObject({ code: 'SCHEDULE_VERSION_CONFLICT' });
  });
});

describe('próximos turnos de un empleado', () => {
  it('lista futuros con fecha, sucursal, horas, duración, estado y si el horario está publicado', async () => {
    const list = await S.employeeShifts(F.ctx, F.admin, F.carlos, { limit: 50 });
    expect(list.length).toBeGreaterThan(3);
    expect(list.every((s) => s.endsAt > now)).toBe(true);
    expect(list[0]).toEqual(expect.objectContaining({ businessDate: expect.any(String), branchId: F.VEN, startTime: expect.any(String), endTime: expect.any(String), scheduledMinutes: expect.any(Number), status: expect.any(String), scheduleStatus: expect.stringMatching(/DRAFT|PUBLISHED/) }));
    expect(new Set(list.map((s) => s.scheduleStatus))).toEqual(new Set(['DRAFT', 'PUBLISHED']));
  });
});

describe('D-33 · un turno publicado nunca se vuelve borrador implícitamente', () => {
  const schedulesOf = async (branchId: string, weekStart: string) =>
    (await pools.platform.query(`SELECT status FROM scheduling.weekly_schedules WHERE organization_id = $1 AND branch_id = $2 AND week_start = $3`, [F.orgId, branchId, weekStart])).rows;

  it('(49) mover un turno PUBLICADO a otra sucursal o semana exige un horario destino existente y PUBLICADO', async () => {
    await world.employees.assignBranch(F.ctx, F.maria, { branchId: F.SMA, kind: 'TEMPORARY', validFrom: '2027-01-11', validTo: '2027-01-31', reason: 'Apoyo' });
    const s = await S.createShift(F.ctx, F.admin, shift(F.maria, F.VEN, '2027-01-12', '07:00', '15:00'));
    const week = await S.getWeek(F.ctx, F.admin, F.VEN, '2027-01-12');
    await S.publish(F.ctx, F.admin, week.schedule!.id, week.schedule!.version);

    // destino inexistente: NO se crea un borrador silencioso
    const missing = await S.updateShift(F.ctx, F.admin, s.id, s.version, { branchId: F.SMA }).catch((e) => e);
    expect(missing).toMatchObject({ code: 'SHIFT_TARGET_SCHEDULE_NOT_PUBLISHED', details: { branchId: F.SMA, weekStart: '2027-01-11', targetStatus: null } });
    expect(await schedulesOf(F.SMA, '2027-01-11')).toEqual([]);
    // otra semana sin horario tampoco
    await expect(S.updateShift(F.ctx, F.admin, s.id, s.version, { date: '2027-01-19' })).rejects.toMatchObject({ code: 'SHIFT_TARGET_SCHEDULE_NOT_PUBLISHED' });
    expect(await schedulesOf(F.VEN, '2027-01-18')).toEqual([]);

    // destino en BORRADOR: también se rechaza
    await S.ensureSchedule(F.ctx, F.admin, F.SMA, '2027-01-12');
    const draft = await S.updateShift(F.ctx, F.admin, s.id, s.version, { branchId: F.SMA }).catch((e) => e);
    expect(draft).toMatchObject({ code: 'SHIFT_TARGET_SCHEDULE_NOT_PUBLISHED', details: { targetStatus: 'DRAFT' } });
    expect(await row(s.id)).toMatchObject({ branch_id: F.VEN, schedule_id: week.schedule!.id, version: s.version }); // intacto

    // destino PUBLICADO: se mueve y sigue siendo oficial
    const sma = await S.getWeek(F.ctx, F.admin, F.SMA, '2027-01-12');
    await S.publish(F.ctx, F.admin, sma.schedule!.id, sma.schedule!.version);
    const moved = await S.updateShift(F.ctx, F.admin, s.id, s.version, { branchId: F.SMA });
    expect(moved).toMatchObject({ branchId: F.SMA, scheduleId: sma.schedule!.id, scheduleStatus: 'PUBLISHED', status: 'SCHEDULED' });
    // y dentro del mismo horario publicado se sigue editando normalmente
    const edited = await S.updateShift(F.ctx, F.admin, s.id, moved.version, { startTime: '08:00', endTime: '16:00' });
    expect(edited).toMatchObject({ scheduleStatus: 'PUBLISHED', startTime: '08:00' });
  });

  it('un turno en BORRADOR sí puede crear el horario destino en borrador', async () => {
    const s = await S.createShift(F.ctx, F.admin, shift(F.maria, F.VEN, '2027-01-26', '07:00', '15:00'));
    expect(s.scheduleStatus).toBe('DRAFT');
    expect(await schedulesOf(F.SMA, '2027-01-25')).toEqual([]);
    const moved = await S.updateShift(F.ctx, F.admin, s.id, s.version, { branchId: F.SMA });
    expect(moved).toMatchObject({ branchId: F.SMA, scheduleStatus: 'DRAFT' });
    expect(await schedulesOf(F.SMA, '2027-01-25')).toEqual([{ status: 'DRAFT' }]);
  });

  it('PostgreSQL también lo impide aunque se salte la aplicación', async () => {
    const draftVen = await S.ensureSchedule(F.ctx, F.admin, F.VEN, '2027-02-02');
    const published = (await pools.platform.query(
      `SELECT s.id FROM scheduling.shifts s JOIN scheduling.weekly_schedules w ON w.id = s.schedule_id
        WHERE s.organization_id = $1 AND s.branch_id = $2 AND w.status = 'PUBLISHED' AND s.status = 'SCHEDULED' LIMIT 1`, [F.orgId, F.SMA])).rows[0].id;
    const sameBranchDraft = await S.ensureSchedule(F.ctx, F.admin, F.SMA, '2027-02-02');
    const c = await pools.platform.connect();
    try {
      await c.query('BEGIN');
      const err = await pgError(c, `UPDATE scheduling.shifts SET schedule_id = $1 WHERE id = $2`, [sameBranchDraft.id, published]);
      expect(err).toMatchObject({ code: 'P0001', message: 'SHIFT_TARGET_SCHEDULE_NOT_PUBLISHED' });
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    expect(draftVen.status).toBe('DRAFT');
  });
});

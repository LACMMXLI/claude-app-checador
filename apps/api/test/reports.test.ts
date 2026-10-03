import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { AccessProfile } from '../src/modules/auth/rbac.service.js';
import { neutralize, toCsv } from '../src/modules/reports/export.js';
import { assertRange, quickPeriods } from '../src/modules/reports/periods.js';
import { ReportsService } from '../src/modules/reports/reports.service.js';
import { type AttendanceFixture, type Person, at, attendanceFixture } from './helpers/attendance-fixture.js';
import { Agent, startServer, type TestServer } from './helpers/http.js';
import { PASSWORD, buildWorld, openPools } from './helpers/world.js';

const pools = openPools();
let now = new Date('2026-09-01T12:00:00Z');
const world = buildWorld(pools, { clock: () => now });
let F: AttendanceFixture;
let G: AttendanceFixture; // otro negocio
let server: TestServer;
let admin: Agent;
let ana: Person;
let beto: Person;
let ceci: Person;
let evil: Person;

const R = world.reports;
const row = (rows: Record<string, unknown>[], name: string) => rows.find((r) => String(r.employee).startsWith(name))!;

beforeAll(async () => {
  G = await attendanceFixture(world, (d) => (now = d));
  F = await attendanceFixture(world, (d) => (now = d));
  await world.policies.setOverride(F.ctx, 'ORGANIZATION', null, { debounceSec: 0, exitToleranceMin: 5 });
  ana = await F.employee('Ana', F.VEN);
  beto = await F.employee('Beto', F.VEN);
  ceci = await F.employee('Ceci', F.SMA);
  evil = await F.employee('@Malicioso', F.VEN);

  // Ana: turno 07–15, entra 07:15 (retardo 15), pausa 30 min, sale 14:30 (salida anticipada 30)
  await F.publishedShift(ana, F.VEN, '2026-10-12', '07:00', '15:00');
  await F.publishedShift(beto, F.VEN, '2026-10-12', '07:00', '15:00');
  const cancelled = await F.publishedShift(beto, F.VEN, '2026-10-13', '07:00', '09:00');
  await F.publishedShift(ceci, F.SMA, '2026-10-12', '07:00', '15:00');
  const steps: [Person, typeof F.kioskVEN, string, string, 'CLOCK_IN' | 'BREAK_START' | 'BREAK_END' | 'CLOCK_OUT'][] = [
    [ana, F.kioskVEN, '2026-10-12', '07:15', 'CLOCK_IN'],
    [ceci, F.kioskSMA, '2026-10-12', '07:00', 'CLOCK_IN'],
    [ana, F.kioskVEN, '2026-10-12', '11:00', 'BREAK_START'],
    [ana, F.kioskVEN, '2026-10-12', '11:30', 'BREAK_END'],
    [ana, F.kioskVEN, '2026-10-12', '14:30', 'CLOCK_OUT'],
    [ceci, F.kioskSMA, '2026-10-12', '15:00', 'CLOCK_OUT'],
  ];
  for (const [p, k, d, t, a] of steps) {
    now = at(d, t);
    await F.punch(k, p, a);
  }
  now = at('2026-10-13', '10:00');
  await world.reconciler.reconcileOrganization(F.orgId); // FALTA de Beto el 12 y el 13
  const v = (await pools.platform.query('SELECT version FROM scheduling.shifts WHERE id = $1', [cancelled.id])).rows[0].version;
  await world.scheduling.cancelShift(F.ctx, F.admin, cancelled.id, v, 'Se le dio el día'); // → FALTA VOIDED
  // Jornada sin turno de "@Malicioso" (nombre que intenta una fórmula)
  now = at('2026-10-13', '12:00');
  await F.punch(F.kioskVEN, evil, 'CLOCK_IN');
  now = at('2026-10-13', '13:00');
  await F.punch(F.kioskVEN, evil, 'CLOCK_OUT');
  // Otro negocio con datos en las mismas fechas
  const intruder = await G.employee('Intrusa', G.VEN);
  now = at('2026-10-12', '08:00');
  await G.punch(G.kioskVEN, intruder, 'CLOCK_IN');

  now = at('2026-10-14', '03:00'); // antes del corte 05:00 → día operativo 2026-10-13
  await pools.platform.query(`INSERT INTO auth.user_credentials (user_id, password_hash) SELECT id, $2 FROM auth.users WHERE email = $1`, [F.managerEmail, await hashPassword(PASSWORD)]);
  server = await startServer(pools, world);
  admin = new Agent(server.baseUrl);
  await admin.login(F.adminEmail, PASSWORD);
});
afterAll(async () => {
  await server.close();
  await pools.close();
});

describe('periodos rápidos (puro)', () => {
  it('hoy, ayer, semana con week_start_day, quincena y mes (actual/anterior)', () => {
    const p = quickPeriods('2026-10-03', 1); // sábado
    expect(p.today).toEqual({ from: '2026-10-03', to: '2026-10-03' });
    expect(p.yesterday).toEqual({ from: '2026-10-02', to: '2026-10-02' });
    expect(p.week_current).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(p.week_previous).toEqual({ from: '2026-09-21', to: '2026-09-27' });
    expect(p.fortnight_current).toEqual({ from: '2026-10-01', to: '2026-10-15' });
    expect(p.fortnight_previous).toEqual({ from: '2026-09-16', to: '2026-09-30' });
    expect(p.month_current).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(p.month_previous).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(quickPeriods('2026-10-03', 7).week_current).toEqual({ from: '2026-09-27', to: '2026-10-03' }); // semana que inicia en domingo
  });
  it('bordes: enero (mes y quincena anteriores en diciembre), febrero bisiesto, segunda quincena', () => {
    const jan = quickPeriods('2028-01-05', 1);
    expect(jan.month_previous).toEqual({ from: '2027-12-01', to: '2027-12-31' });
    expect(jan.fortnight_previous).toEqual({ from: '2027-12-16', to: '2027-12-31' });
    const feb = quickPeriods('2028-02-20', 1);
    expect(feb.fortnight_current).toEqual({ from: '2028-02-16', to: '2028-02-29' });
    expect(feb.fortnight_previous).toEqual({ from: '2028-02-01', to: '2028-02-15' });
  });
  it('rango máximo 366 días; desde > hasta es inválido', () => {
    expect(() => assertRange('2026-01-01', '2027-01-01')).not.toThrow(); // 366
    expect(() => assertRange('2026-01-01', '2027-01-02')).toThrow(expect.objectContaining({ code: 'REPORT_RANGE_TOO_LONG' }));
    expect(() => assertRange('2026-02-01', '2026-01-01')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
  it('el endpoint usa el DÍA OPERATIVO (zona + corte), no la fecha UTC', async () => {
    const r = await R.periods(F.ctx, F.admin, F.VEN);
    expect(r).toMatchObject({ today: '2026-10-13', timezone: 'America/Tijuana' });
    expect(r.periods.yesterday).toEqual({ from: '2026-10-12', to: '2026-10-12' });
  });
});

describe('reporte de asistencia (D-73)', () => {
  const range = { from: '2026-10-12', to: '2026-10-13' };

  it('resumen por empleado: totales efectivos; la FALTA anulada no cuenta (F)', async () => {
    const r = await R.run(F.ctx, F.admin, { report: 'summary', ...range });
    expect(row(r.rows, 'Ana')).toMatchObject({
      scheduledShifts: 1,
      sessions: 1,
      scheduledMinutes: 480,
      workedMinutes: 435,
      lates: 1,
      lateMinutes: 15,
      earlyLeaves: 1,
      earlyMinutes: 30,
      breaks: 1,
      breakMinutes: 30,
      absences: 0,
    });
    expect(row(r.rows, 'Beto')).toMatchObject({ scheduledShifts: 1, sessions: 0, absences: 1 }); // el turno cancelado ya no es plan
    expect(row(r.rows, '@Malicioso')).toMatchObject({ unscheduled: 1, scheduledShifts: 0 });
    expect(r.rows.map((x) => x.employee)).not.toContain('Intrusa');
  });

  it('detalle de jornadas: una fila por jornada y una por FALTA real (no la anulada)', async () => {
    const r = await R.run(F.ctx, F.admin, { report: 'sessions', ...range });
    const betos = r.rows.filter((x) => x.employee === 'Beto');
    expect(betos).toEqual([expect.objectContaining({ operationalDate: '2026-10-12', status: 'Falta', clockIn: null })]);
    expect(row(r.rows, 'Ana')).toMatchObject({ clockIn: '2026-10-12 07:15', clockOut: '2026-10-12 14:30', arrivalDelta: 15, departureDelta: -30, shift: '07:00–15:00' });
    expect(String(row(r.rows, 'Ana').incidents)).toMatch(/Retardo/);
    expect(String(row(r.rows, 'Ana').incidents)).toMatch(/Salida anticipada/);
  });

  it('incidencias: incluye la anulada por el sistema, visible con su origen y motivo', async () => {
    const r = await R.run(F.ctx, F.admin, { report: 'incidents', ...range, employeeId: beto.id });
    expect(r.rows).toHaveLength(2);
    expect(r.rows.find((x) => x.resolution === 'Anulada por el sistema')).toMatchObject({ type: 'Falta', resolutionSource: 'Sistema', reason: 'SHIFT_CANCELLED: Se le dio el día', operationalDate: '2026-10-13' });
  });

  it('alcance: la encargada de Venecia no ve San Marcos; pedir una sucursal fuera de su alcance es 404', async () => {
    const r = await R.run(F.managerCtx, F.manager, { report: 'summary', ...range });
    expect(r.rows.map((x) => x.employee)).not.toContain('Ceci');
    expect(r.rows.map((x) => x.employee)).toContain('Ana');
    await expect(R.run(F.managerCtx, F.manager, { report: 'summary', ...range, branchId: F.SMA })).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
    const all = await R.run(F.ctx, F.admin, { report: 'summary', ...range });
    expect(all.rows.map((x) => x.employee)).toContain('Ceci');
  });

  it('periodo rápido resuelto en el servidor y rango > 366 días rechazado', async () => {
    const r = await R.run(F.ctx, F.admin, { report: 'sessions', period: 'yesterday', branchId: F.VEN });
    expect([r.from, r.to]).toEqual(['2026-10-12', '2026-10-12']);
    await expect(R.run(F.ctx, F.admin, { report: 'summary', from: '2025-01-01', to: '2026-10-13' })).rejects.toMatchObject({ code: 'REPORT_RANGE_TOO_LONG' });
  });

  it('RLS como última capa: con un RBAC "roto" (todo, todas las sucursales) no aparece nada de otro negocio', async () => {
    const broken = new AccessProfile([{ permissions: new Set(['reports.view', 'reports.export']), branchIds: null }]);
    const r = await R.run(F.ctx, broken, { report: 'sessions', ...range, branchId: G.VEN });
    expect(r.rows).toEqual([]);
    const s = await R.run(F.ctx, broken, { report: 'summary', ...range });
    expect(s.rows.map((x) => x.employee)).not.toContain('Intrusa');
  });
});

describe('exportación (D-74, decisión 7)', () => {
  it('CSV: BOM, RFC 4180 y fórmulas neutralizadas', () => {
    expect(neutralize('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(neutralize('-1')).toBe("'-1");
    expect(neutralize('Ana')).toBe('Ana');
    const csv = toCsv({ report: 'summary', from: 'a', to: 'b', branchId: null, employeeId: null, columns: [{ key: 'a', header: 'A', kind: 'text' }, { key: 'n', header: 'N', kind: 'number' }], rows: [{ a: 'x, "y"\nz', n: -3 }, { a: '+1', n: null }] });
    expect([...csv.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.subarray(3).toString('utf8')).toBe('A,N\r\n"x, ""y""\nz",-3\r\n\'+1,\r\n');
  });

  it('HTTP: CSV con encabezados de descarga, no-store y nombre con fechas', async () => {
    const res = await admin.raw('POST', '/api/reports/export', { format: 'csv', filters: { report: 'sessions', from: '2026-10-12', to: '2026-10-13' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="detalle-de-jornadas_2026-10-12_2026-10-13.csv"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain("'@Malicioso");
    expect(text).not.toContain('Intrusa');
  });

  it('HTTP: XLSX con hoja del reporte y hoja "Parámetros"; auditado con filtros y filas', async () => {
    const res = await admin.raw('POST', '/api/reports/export', { format: 'xlsx', filters: { report: 'summary', from: '2026-10-12', to: '2026-10-13', branchId: F.VEN } });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Resumen por empleado', 'Parámetros']);
    const sheet = wb.worksheets[0]!;
    expect(sheet.getRow(1).getCell(2).value).toBe('Empleado');
    const names = sheet.getColumn(2).values.slice(2);
    expect(names).toContain("'@Malicioso");
    expect(names).not.toContain('Ceci'); // filtro por Venecia
    const params = Object.fromEntries(wb.worksheets[1]!.getSheetValues().slice(2).map((r) => [(r as unknown[])[1], (r as unknown[])[2]]));
    expect(params).toMatchObject({ Sucursal: 'Venecia', 'Desde (día operativo)': '2026-10-12', 'Zona horaria': 'America/Tijuana' });
    const audit = await pools.platform.query(`SELECT branch_id, after FROM audit.audit_log WHERE organization_id = $1 AND action = 'report.exported' AND after->>'format' = 'xlsx'`, [F.orgId]);
    expect(audit.rows[0]).toMatchObject({ branch_id: F.VEN, after: { report: 'summary', format: 'xlsx', from: '2026-10-12', to: '2026-10-13', rows: sheet.rowCount - 1 } });
  });

  it('requiere reports.export además de reports.view', async () => {
    const viewer = new AccessProfile([{ permissions: new Set(['reports.view']), branchIds: null }]);
    await expect(R.export(F.ctx, viewer, { report: 'summary', from: '2026-10-12', to: '2026-10-13' }, 'csv')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const exporter = new AccessProfile([{ permissions: new Set(['reports.export']), branchIds: null }]);
    await expect(R.export(F.ctx, exporter, { report: 'summary', from: '2026-10-12', to: '2026-10-13' }, 'csv')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('máximo de filas: excederlo rechaza sin generar archivo ni registrar exportación', async () => {
    const small = new ReportsService((R as unknown as { tenantDb: never }).tenantDb, world.policies, new AuditService(), () => now, { maxRows: 1, perMinute: 10 });
    const before = (await pools.platform.query(`SELECT count(*)::int AS n FROM audit.audit_log WHERE organization_id = $1 AND action = 'report.exported'`, [F.orgId])).rows[0].n;
    await expect(small.export(F.ctx, F.admin, { report: 'sessions', from: '2026-10-12', to: '2026-10-13' }, 'csv')).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' });
    const after = (await pools.platform.query(`SELECT count(*)::int AS n FROM audit.audit_log WHERE organization_id = $1 AND action = 'report.exported'`, [F.orgId])).rows[0].n;
    expect(after).toBe(before);
  });

  it('10 exportaciones por minuto por usuario (también en paralelo); la siguiente es 429', async () => {
    const filter = { report: 'summary' as const, from: '2026-10-12', to: '2026-10-12' };
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => R.export(F.managerCtx, F.manager, filter, 'csv')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(['EXPORT_RATE_LIMITED', 'EXPORT_RATE_LIMITED']);
    const mgr = new Agent(server.baseUrl);
    await mgr.login(F.managerEmail, PASSWORD);
    const res = await mgr.post('/api/reports/export', { format: 'csv', filters: filter });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('EXPORT_RATE_LIMITED');
    // otro usuario no se ve afectado
    expect((await admin.raw('POST', '/api/reports/export', { format: 'csv', filters: filter })).status).toBe(200);
  });

  it('HTTP: GET de reporte valida filtros y alcance', async () => {
    const ok = await admin.get('/api/reports/attendance?report=summary&from=2026-10-12&to=2026-10-13');
    expect(ok.status).toBe(200);
    expect(ok.body.columns[0]).toMatchObject({ key: 'employeeNumber' });
    expect((await admin.get('/api/reports/attendance?report=summary&period=today&from=2026-10-12')).status).toBe(400);
    expect((await admin.get(`/api/reports/attendance?report=summary&period=today&branchId=${G.VEN}`)).status).toBe(404);
    const periods = await admin.get(`/api/reports/periods?branchId=${F.VEN}`);
    expect(periods.body.today).toBe('2026-10-13');
  });
});

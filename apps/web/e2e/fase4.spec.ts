import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'dueno@fatboy.example';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'contraseña-larga-123';
const H = { 'x-requested-with': 'checador' };
const TZ = 'America/Tijuana';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Correo').fill(ADMIN_EMAIL);
  await page.getByLabel('Contraseña').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Inicio' })).toBeVisible();
  // antirrebote en 0 para encadenar checadas en segundos (configurable por negocio)
  expect((await page.request.put('/api/policies/override', { headers: H, data: { scope: 'ORGANIZATION', values: { debounceSec: 0 } } })).status()).toBe(200);
}

function local(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

async function venecia(page: Page): Promise<string> {
  const branches = await (await page.request.get('/api/branches')).json();
  return branches.find((b: { name: string }) => b.name === 'Venecia').id;
}

async function newEmployee(page: Page, branchId: string, name: string) {
  const stamp = `${Date.now()}`.slice(-6);
  const r = await page.request.post('/api/employees', { headers: H, data: { employeeNumber: `${name}-${stamp}`, firstName: name, lastName: stamp, primaryBranchId: branchId, hiredAt: local(new Date(Date.now() - 7 * 86_400_000)).date } });
  expect(r.status()).toBe(201);
  const body = await r.json();
  return { id: body.employee.id as string, pin: body.pin as string, name, lastName: stamp };
}

async function publishedShift(page: Page, branchId: string, employeeId: string, date: string, startTime: string, endTime: string) {
  const r = await page.request.post('/api/shifts', { headers: H, data: { branchId, employeeId, date, startTime, endTime, reason: 'Prueba E2E' } });
  expect(r.status(), await r.text()).toBe(201);
  const week = await (await page.request.get(`/api/schedules/week?branchId=${branchId}&date=${date}`)).json();
  if (week.schedule.status === 'DRAFT') {
    const pub = await page.request.post(`/api/schedules/${week.schedule.id}/publish`, { headers: H, data: { expectedVersion: week.schedule.version } });
    expect(pub.status()).toBe(200);
  }
  return (await r.json()).id as string;
}

/** Tablet activada en un contexto propio (su cookie HttpOnly de dispositivo). */
async function openKiosk(browser: Browser, page: Page, branchId: string) {
  const created = await page.request.post('/api/kiosks', { headers: H, data: { name: `Tablet ${Date.now()}`, branchId } });
  expect(created.status()).toBe(201);
  const { token, device } = await created.json();
  const context = await browser.newContext();
  const kiosk = await context.newPage();
  await kiosk.goto('/kiosco');
  await kiosk.getByLabel('Token o código').fill(token);
  await kiosk.getByRole('button', { name: 'Activar' }).click();
  await expect(kiosk.getByRole('heading', { name: 'Escribe tu código' })).toBeVisible();
  return { kiosk, context, deviceId: device.id as string };
}

async function typePin(kiosk: Page, pin: string) {
  await expect(kiosk.getByRole('heading', { name: 'Escribe tu código' })).toBeVisible({ timeout: 10_000 });
  for (const d of pin) await kiosk.getByRole('button', { name: d, exact: true }).click();
  await kiosk.getByRole('button', { name: 'Confirmar' }).click();
}

/** Checadas por la API del kiosco (mismo camino que la tablet), para preparar datos rápido. */
async function apiPunches(kiosk: Page, pin: string, actions: string[]) {
  for (const action of actions) {
    const who = await kiosk.request.post('/api/kiosk/identify', { headers: H, data: { pin } });
    expect(who.status()).toBe(200);
    const r = await kiosk.request.post('/api/kiosk/punch', { headers: H, data: { ticket: (await who.json()).ticket, action, clientEventId: crypto.randomUUID() } });
    expect(r.status(), await r.text()).toBe(200);
  }
}

async function sessionsOf(page: Page, employeeId: string) {
  return (await page.request.get(`/api/attendance/sessions?employeeId=${employeeId}&from=2020-01-01&to=2099-12-31`)).json();
}

/** Desde "Mis registros" del kiosco: pide corregir la hora de una jornada. */
async function kioskRequest(kiosk: Page, date: string, option: string, at: { date: string; time: string }, reason: string) {
  await kiosk.getByTestId('kiosk-my-records').click();
  await expect(kiosk.getByTestId('kiosk-records')).toBeVisible();
  await kiosk.getByLabel(`Solicitar corrección ${date}`).first().selectOption({ label: option });
  await kiosk.getByTestId('req-start-date').fill(at.date);
  await kiosk.getByTestId('req-start-time').fill(at.time);
  await kiosk.getByLabel('Motivo').fill(reason);
  await kiosk.getByRole('button', { name: 'Enviar solicitud' }).click();
  await expect(kiosk.getByTestId('request-sent')).toBeVisible();
  await expect(kiosk.getByTestId('my-requests')).toContainText('Pendiente');
}

test('(53) solicitud en kiosco → aprobación en el panel → corrección auditada e historial', async ({ page, browser }) => {
  await login(page);
  const ven = await venecia(page);
  const dani = await newEmployee(page, ven, 'Dani');
  const { kiosk, context } = await openKiosk(browser, page, ven);
  await apiPunches(kiosk, dani.pin, ['CLOCK_IN', 'CLOCK_OUT']);
  const [session] = await sessionsOf(page, dani.id);
  const fixed = local(new Date(new Date(session.startedAt).getTime() - 5 * 60_000));

  await kiosk.reload();
  await typePin(kiosk, dani.pin);
  await expect(kiosk.getByTestId('kiosk-employee')).toHaveText('Hola, Dani');
  await kioskRequest(kiosk, session.operationalDate, 'Corregir hora de Entrada', fixed, 'Llegué antes pero el kiosco no respondía');
  // "Terminar": vuelve al PIN sin rastro de la persona (precisión G)
  await kiosk.getByTestId('kiosk-finish').click();
  await expect(kiosk.getByRole('heading', { name: 'Escribe tu código' })).toBeVisible();
  await expect(kiosk.getByText('Dani')).toHaveCount(0);
  await kiosk.goBack().catch(() => undefined);
  await expect(kiosk.getByText('Llegué antes')).toHaveCount(0);
  await context.close();

  // el panel muestra la solicitud pendiente y la jornada NO cambió todavía
  await page.reload();
  await expect(page.getByTestId('pending-badge')).toBeVisible();
  expect((await sessionsOf(page, dani.id))[0].startedAt).toBe(session.startedAt);
  await page.getByRole('link', { name: /Solicitudes/ }).click();
  await expect(page.getByRole('heading', { name: 'Solicitudes de corrección' })).toBeVisible();
  const row = page.getByTestId('requests').locator('tr').filter({ hasText: dani.lastName });
  await row.getByRole('button', { name: 'Corregir hora de Entrada' }).click();
  await expect(page.getByTestId('request-detail')).toContainText('Llegué antes pero el kiosco no respondía');
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/solicitud-detalle.png`, fullPage: true });
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('request-detail')).toContainText('Aprobada');

  // la corrección quedó aplicada EXACTAMENTE como se pidió, auditada, y el evento físico intacto
  await page.goto(`/jornadas/${session.id}`);
  await expect(page.getByTestId('corrections')).toContainText('Dueño Fatboy');
  await expect(page.getByTestId('session-requests')).toContainText('Aprobada');
  await expect(page.getByTestId('recorded')).toContainText('Entrada');
  const after = (await sessionsOf(page, dani.id))[0];
  expect(local(new Date(after.startedAt))).toEqual(fixed);
  await page.goto(`/empleados/${dani.id}`);
  await expect(page.getByTestId('attendance-history')).toContainText('1 · Dueño Fatboy');
});

test('(54) rechazo con motivo visible para el empleado y nadie aprueba su propia solicitud', async ({ page, browser }) => {
  await login(page);
  const ven = await venecia(page);
  const eva = await newEmployee(page, ven, 'Eva');
  const { kiosk, context } = await openKiosk(browser, page, ven);
  await apiPunches(kiosk, eva.pin, ['CLOCK_IN', 'CLOCK_OUT']);
  const [session] = await sessionsOf(page, eva.id);
  await kiosk.reload();
  await typePin(kiosk, eva.pin);
  await kioskRequest(kiosk, session.operationalDate, 'Corregir hora de Salida', local(new Date(session.endedAt)), 'Salí más tarde');
  await kiosk.getByTestId('kiosk-finish').click();

  await page.goto('/solicitudes');
  const row = page.getByTestId('requests').locator('tr').filter({ hasText: eva.lastName });
  await row.getByRole('button', { name: 'Corregir hora de Salida' }).click();
  await page.getByLabel('Motivo del rechazo').fill('No coincide con la cámara');
  await page.getByTestId('reject').click();
  await expect(page.getByTestId('request-detail')).toContainText('Rechazada');

  // el empleado ve el rechazo y el motivo en el kiosco
  await typePin(kiosk, eva.pin);
  await kiosk.getByTestId('kiosk-my-records').click();
  await expect(kiosk.getByTestId('my-requests')).toContainText('Rechazada');
  await expect(kiosk.getByTestId('my-requests')).toContainText('No coincide con la cámara');
  // sin tocar nada: a los 20 s se cierra sola y no queda ningún dato de la persona (precisión G)
  await expect(kiosk.getByRole('heading', { name: 'Escribe tu código' })).toBeVisible({ timeout: 25_000 });
  await expect(kiosk.getByText('No coincide con la cámara')).toHaveCount(0);
  await expect(kiosk.getByText('Eva')).toHaveCount(0);

  // "no autoaprobación": la cuenta del dueño se liga a una ficha y solicita sobre su propia jornada
  const self = await newEmployee(page, ven, 'Propio');
  const members = await (await page.request.get('/api/members')).json();
  const mine = members.find((m: { email: string }) => m.email === ADMIN_EMAIL);
  expect((await page.request.patch(`/api/members/${mine.membershipId}/employee`, { headers: H, data: { employeeId: self.id } })).status()).toBe(200);
  try {
    await apiPunches(kiosk, self.pin, ['CLOCK_IN', 'CLOCK_OUT']);
    const [own] = await sessionsOf(page, self.id);
    await page.goto('/mis-jornadas');
    await expect(page.getByRole('heading', { name: 'Mis jornadas' })).toBeVisible();
    await page.getByLabel(`Solicitar corrección ${own.operationalDate}`).selectOption({ label: 'Corregir hora de Salida' });
    await page.getByLabel('Motivo').fill('Prueba de autoaprobación');
    await page.getByRole('button', { name: 'Enviar solicitud' }).click();
    await expect(page.getByTestId('my-requests')).toContainText('Pendiente');
    const list = await (await page.request.get(`/api/attendance/correction-requests?employeeId=${self.id}&status=PENDING`)).json();
    expect(list).toHaveLength(1);
    expect(list[0].canDecide).toBe(false);
    const attempt = await page.request.post(`/api/attendance/correction-requests/${list[0].id}/approve`, { headers: H, data: { expectedVersion: list[0].version } });
    expect(attempt.status()).toBe(403);
    expect((await attempt.json()).error.code).toBe('SELF_APPROVAL_FORBIDDEN');
    await page.goto(`/solicitudes?id=${list[0].id}`);
    await expect(page.getByText('No puedes decidir esta solicitud')).toBeVisible();
    await expect(page.getByTestId('approve')).toHaveCount(0);
    // la cancela el propio solicitante
    await page.goto('/mis-jornadas');
    await page.getByRole('button', { name: 'Cancelar solicitud' }).click();
    await expect(page.getByTestId('my-requests')).toContainText('Cancelada');
  } finally {
    await page.request.patch(`/api/members/${mine.membershipId}/employee`, { headers: H, data: { employeeId: null } });
    await context.close();
  }
});

test('(55) asistencia en vivo por SSE (sin recargar) y respaldo por polling si el canal falla', async ({ page, browser }) => {
  await login(page);
  const ven = await venecia(page);
  const fer = await newEmployee(page, ven, 'Fer');
  const { kiosk, context } = await openKiosk(browser, page, ven);

  await page.goto('/asistencia');
  await page.getByLabel('Sucursal').selectOption({ label: 'Venecia' });
  await expect(page.getByTestId('live-indicator')).toHaveAttribute('data-status', 'connected', { timeout: 15_000 });
  await apiPunches(kiosk, fer.pin, ['CLOCK_IN']);
  // aparece en segundos: el polling de respaldo (30 s / 120 s) no alcanzaría
  await expect(page.getByTestId(`live-row-${fer.id}`)).toContainText('Trabajando', { timeout: 8_000 });
  await apiPunches(kiosk, fer.pin, ['BREAK_START']);
  await expect(page.getByTestId(`live-row-${fer.id}`)).toContainText('En comida', { timeout: 8_000 });
  await context.close();

  // canal en vivo no disponible (p. ej. un proxy que no transmite): la pantalla sigue funcionando por polling
  const other = await browser.newPage();
  await other.route('**/api/attendance/stream**', (route) => route.fulfill({ status: 503, body: '' }));
  await login(other);
  await other.goto('/asistencia');
  await other.getByLabel('Sucursal').selectOption({ label: 'Venecia' });
  await expect(other.getByTestId('live-indicator')).toHaveAttribute('data-status', 'polling', { timeout: 15_000 });
  await expect(other.getByTestId('live-indicator')).toHaveText('Actualización cada 30 s');
  await expect(other.getByTestId(`live-row-${fer.id}`)).toContainText('En comida');
  await other.close();
});

test('(56) reportes con periodo rápido y descarga XLSX/CSV', async ({ page, browser }) => {
  await login(page);
  const ven = await venecia(page);
  const gina = await newEmployee(page, ven, '=Gina');
  const { kiosk, context } = await openKiosk(browser, page, ven);
  await apiPunches(kiosk, gina.pin, ['CLOCK_IN', 'CLOCK_OUT']);
  await context.close();

  await page.getByRole('link', { name: 'Reportes' }).click();
  await expect(page.getByRole('heading', { name: 'Reportes' })).toBeVisible();
  await page.getByTestId('report-kind').selectOption({ label: 'Detalle de jornadas' });
  await page.getByTestId('report-period').selectOption({ label: 'Hoy' });
  // "Hoy" es el DÍA OPERATIVO del negocio (zona + hora de corte), no la fecha del calendario
  const { today } = await (await page.request.get('/api/reports/periods')).json();
  await expect(page.getByTestId('report-range')).toContainText(today);
  await page.getByTestId('report-run').click();
  await expect(page.getByTestId('report-table')).toContainText(gina.lastName);
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/reportes.png`, fullPage: true });

  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-csv').click()]);
  expect(csv.suggestedFilename()).toBe(`detalle-de-jornadas_${today}_${today}.csv`);
  const text = readFileSync((await csv.path())!, 'utf8');
  expect(text.charCodeAt(0)).toBe(0xfeff); // BOM: Excel abre bien los acentos
  expect(text).toContain(`'=Gina ${gina.lastName}`); // fórmula neutralizada
  const [xlsx] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-xlsx').click()]);
  expect(xlsx.suggestedFilename()).toBe(`detalle-de-jornadas_${today}_${today}.xlsx`);
  expect(readFileSync((await xlsx.path())!).subarray(0, 2).toString()).toBe('PK');
});

test('(57) cancelar el turno ANULA la falta: visible como "Anulada por el sistema" y fuera de los totales', async ({ page }) => {
  await login(page);
  const ven = await venecia(page);
  const hugo = await newEmployee(page, ven, 'Hugo');
  const day = local(new Date(Date.now() - 2 * 86_400_000)).date;
  const shiftId = await publishedShift(page, ven, hugo.id, day, '07:00', '09:00');
  execFileSync('node', [path.resolve(process.cwd(), '../api/dist/src/cli/reconcile.js')], { env: { ...process.env, DATABASE_URL: process.env.E2E_APP_DATABASE_URL } });
  const open = await (await page.request.get(`/api/attendance/incidents?type=FALTA&status=OPEN&from=${day}&to=${day}`)).json();
  expect(open.filter((i: { employeeId: string }) => i.employeeId === hugo.id)).toHaveLength(1);

  const week = await (await page.request.get(`/api/schedules/week?branchId=${ven}&date=${day}`)).json();
  const shift = week.shifts.find((s: { id: string }) => s.id === shiftId);
  const cancel = await page.request.post(`/api/shifts/${shiftId}/cancel`, { headers: H, data: { expectedVersion: shift.version, reason: 'Se le dio el día' } });
  expect(cancel.status(), await cancel.text()).toBe(200);

  await page.goto('/incidencias');
  await page.getByLabel('Estado').selectOption({ label: 'Resuelta' });
  await page.getByLabel('Incidencias').selectOption({ label: 'Falta' });
  const row = page.getByTestId('incident-FALTA').filter({ hasText: hugo.lastName });
  await expect(row).toContainText('Anulada por el sistema');
  await expect(row).toContainText('SHIFT_CANCELLED: Se le dio el día');
  const summary = await (await page.request.get(`/api/reports/attendance?report=summary&from=${day}&to=${day}&employeeId=${hugo.id}`)).json();
  expect(summary.rows[0]).toMatchObject({ absences: 0, scheduledShifts: 0 });
  const incidents = await (await page.request.get(`/api/reports/attendance?report=incidents&from=${day}&to=${day}&employeeId=${hugo.id}`)).json();
  expect(incidents.rows[0]).toMatchObject({ type: 'Falta', resolution: 'Anulada por el sistema', resolutionSource: 'Sistema' });
});

test('(58) pausa omitida: se agrega por corrección con motivo, sin inventar eventos físicos', async ({ page }) => {
  await login(page);
  const ven = await venecia(page);
  const ivan = await newEmployee(page, ven, 'Ivan');
  const day = local(new Date(Date.now() - 86_400_000)).date;
  const created = await page.request.post('/api/attendance/sessions', {
    headers: H,
    data: { employeeId: ivan.id, branchId: ven, start: { date: day, time: '08:00' }, end: { date: day, time: '16:00' }, reason: 'Lista firmada' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const [session] = await sessionsOf(page, ivan.id);

  await page.goto(`/jornadas/${session.id}`);
  const form = page.getByTestId('correction-form');
  await form.getByLabel('Corrección', { exact: true }).selectOption({ label: 'Agregar pausa omitida' });
  await form.getByLabel('Inicio de la pausa · Fecha').fill(day);
  await form.getByLabel('Inicio de la pausa · Hora').fill('12:00');
  await form.getByLabel('Regreso de la pausa · Fecha').fill(day);
  await form.getByLabel('Regreso de la pausa · Hora').fill('12:30');
  await form.getByLabel('Motivo', { exact: true }).fill('Comió y olvidó checar');
  await form.getByRole('button', { name: 'Aplicar corrección' }).click();
  await expect(page.getByTestId('corrections')).toContainText('Comió y olvidó checar');
  await expect(page.getByTestId('effective')).toContainText('30 min');
  await expect(page.getByText('Sin eventos físicos (jornada creada por corrección).')).toBeVisible(); // nada físico inventado
});

test('(59) monitoreo de kioscos: estado, último uso y "Revocar ahora" deja fuera a la tablet', async ({ page, browser }) => {
  await login(page);
  const ven = await venecia(page);
  const juan = await newEmployee(page, ven, 'Juan');
  const { kiosk, context, deviceId } = await openKiosk(browser, page, ven);

  await page.goto('/kioscos');
  const row = page.getByTestId(`kiosk-${deviceId}`);
  await expect(row.getByTestId('kiosk-state')).toHaveText('Activo');
  await expect(row).toContainText('Última IP');
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/kioscos.png`, fullPage: true });
  await row.getByRole('button', { name: 'Revocar ahora' }).click();
  await expect(row.getByTestId('kiosk-state')).toHaveText('Sin credencial');

  // la tablet conserva su cookie, pero el servidor ya no la acepta
  await typePin(kiosk, juan.pin);
  await expect(kiosk.getByRole('heading', { name: 'Activar este kiosco' })).toBeVisible();
  await context.close();
});

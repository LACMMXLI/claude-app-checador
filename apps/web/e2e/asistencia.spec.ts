import { execFileSync } from 'node:child_process';
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
}

/** Fecha y hora local de Tijuana (la zona de Fatboy) para un instante. */
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

/** Turno OFICIAL: lo crea (con motivo si ya empezó) y publica su semana si estaba en borrador. */
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

/** Tablet nueva: el admin crea el kiosco (token mostrado una vez) y la tablet se activa pegándolo. */
async function openKiosk(browser: Browser, page: Page, branchId: string) {
  const created = await page.request.post('/api/kiosks', { headers: H, data: { name: `Tablet ${Date.now()}`, branchId } });
  expect(created.status()).toBe(201);
  const { token } = await created.json();
  const context = await browser.newContext();
  const kiosk = await context.newPage();
  await kiosk.goto('/kiosco');
  await expect(kiosk.getByRole('heading', { name: 'Activar este kiosco' })).toBeVisible();
  await kiosk.getByLabel('Token o código').fill(token);
  await kiosk.getByRole('button', { name: 'Activar' }).click();
  await expect(kiosk.getByRole('heading', { name: 'Escribe tu código' })).toBeVisible();
  await expect(kiosk.getByTestId('kiosk-branch')).toHaveText('Venecia');
  // la credencial quedó en una cookie HttpOnly: nada en localStorage
  expect(await kiosk.evaluate(() => Object.keys(window.localStorage).length)).toBe(0);
  const cookies = await context.cookies();
  expect(cookies.find((c) => c.name === 'kiosk')?.httpOnly).toBe(true);
  return { kiosk, context };
}

async function typePin(kiosk: Page, pin: string) {
  for (const d of pin) await kiosk.getByRole('button', { name: d, exact: true }).click();
  await kiosk.getByRole('button', { name: 'Confirmar' }).click();
}

async function punch(kiosk: Page, pin: string, name: string, action: string, done: string) {
  await expect(kiosk.getByRole('heading', { name: 'Escribe tu código' })).toBeVisible({ timeout: 10_000 });
  await typePin(kiosk, pin);
  await expect(kiosk.getByTestId('kiosk-employee')).toHaveText(`Hola, ${name}`);
  await kiosk.getByRole('button', { name: action, exact: true }).click();
  await expect(kiosk.getByTestId('kiosk-done')).toContainText(done);
  // regresa solo a la pantalla de PIN, sin datos del empleado anterior
  await expect(kiosk.getByRole('heading', { name: 'Escribe tu código' })).toBeVisible({ timeout: 10_000 });
  await expect(kiosk.getByText(`Hola, ${name}`)).toHaveCount(0);
}

test('(50) kiosco completo: activar → PIN → Entrada → Salida a comer → Regreso → Salida', async ({ page, browser }) => {
  await login(page);
  // antirrebote en 0 para encadenar las 4 checadas en segundos (RN-EVT-02 es configurable por negocio)
  expect((await page.request.put('/api/policies/override', { headers: H, data: { scope: 'ORGANIZATION', values: { debounceSec: 0 } } })).status()).toBe(200);
  const ven = await venecia(page);
  const ana = await newEmployee(page, ven, 'Ana');
  const { kiosk, context } = await openKiosk(browser, page, ven);

  if (process.env.E2E_SCREENSHOTS) await kiosk.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/kiosco-pin.png` });
  // PIN incorrecto: mensaje genérico, sin revelar nada
  await typePin(kiosk, ana.pin === '135792' ? '246813' : '135792');
  await expect(kiosk.getByText('Código no válido.')).toBeVisible();

  await typePin(kiosk, ana.pin);
  await expect(kiosk.getByTestId('kiosk-employee')).toHaveText('Hola, Ana');
  await expect(kiosk.getByRole('button', { name: 'Entrada', exact: true })).toBeVisible();
  if (process.env.E2E_SCREENSHOTS) await kiosk.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/kiosco-acciones.png` });
  await expect(kiosk.getByRole('button', { name: 'Salida', exact: true })).toHaveCount(0); // no se muestran acciones imposibles
  await kiosk.getByRole('button', { name: 'Entrada', exact: true }).click();
  await expect(kiosk.getByTestId('kiosk-done')).toContainText('Entrada registrada');
  await expect(kiosk.getByRole('heading', { name: 'Escribe tu código' })).toBeVisible({ timeout: 10_000 });

  await punch(kiosk, ana.pin, 'Ana', 'Salida a comer', 'Salida a comer registrada');
  // en comida solo se ofrece "Regreso de comer"
  await typePin(kiosk, ana.pin);
  await expect(kiosk.getByRole('button', { name: 'Regreso de comer' })).toBeVisible();
  await expect(kiosk.getByRole('button', { name: 'Salida', exact: true })).toHaveCount(0);
  await kiosk.getByRole('button', { name: 'Regreso de comer' }).click();
  await expect(kiosk.getByTestId('kiosk-done')).toContainText('Regreso de comer registrado');
  await punch(kiosk, ana.pin, 'Ana', 'Salida', 'Salida registrada');

  const today = local(new Date()).date;
  const sessions = await (await page.request.get(`/api/attendance/sessions?employeeId=${ana.id}&from=${today.slice(0, 8)}01&to=2099-12-31`)).json();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ status: 'CLOSED', metrics: { breakCount: 1 } });
  const detail = await (await page.request.get(`/api/attendance/sessions/${sessions[0].id}`)).json();
  expect(detail.recorded.map((e: { type: string }) => e.type)).toEqual(['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT']);
  await context.close();
});

test('(51) administrativo: turno publicado → Entrada tardía → tablero → corrección con motivo → historial', async ({ page, browser }) => {
  await login(page);
  const ven = await venecia(page);
  const beto = await newEmployee(page, ven, 'Beto');
  const start = new Date(Math.floor((Date.now() - 20 * 60_000) / 60_000) * 60_000); // empezó hace 20 min
  const s = local(start);
  const e = local(new Date(start.getTime() + 3 * 3_600_000));
  await publishedShift(page, ven, beto.id, s.date, s.time, e.time);

  const { kiosk, context } = await openKiosk(browser, page, ven);
  await punch(kiosk, beto.pin, 'Beto', 'Entrada', 'Entrada registrada');
  await context.close();

  // Tablero en vivo: Trabajando con los minutos REALES de retardo
  await page.getByRole('link', { name: 'Asistencia', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Asistencia en vivo' })).toBeVisible();
  await page.getByLabel('Sucursal').selectOption({ label: 'Venecia' });
  const row = page.getByTestId(`live-row-${beto.id}`);
  await expect(row).toContainText('Trabajando');
  await expect(row.getByTestId('arrival')).toHaveText(/^\+2[01] min$/);
  await expect(row).toContainText('Retardo');
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/asistencia-en-vivo.png`, fullPage: true });

  // Detalle: programado vs registrado vs efectivo; corrección autorizada con motivo
  await row.getByRole('link', { name: 'Ver' }).click();
  await expect(page.getByRole('heading', { name: /Jornada · Beto/ })).toBeVisible();
  await expect(page.getByTestId('recorded')).toContainText('Entrada');
  const fixed = local(new Date(start.getTime() + 5 * 60_000));
  const form = page.getByTestId('correction-form');
  await form.getByLabel('Corrección', { exact: true }).selectOption({ label: 'Hora de Entrada' });
  await form.getByLabel('Fecha', { exact: true }).fill(fixed.date);
  await form.getByLabel('Hora', { exact: true }).fill(fixed.time);
  await form.getByLabel('Motivo', { exact: true }).fill('Había fila en el kiosco; lo confirmó el encargado');
  await form.getByRole('button', { name: 'Aplicar corrección' }).click();
  await expect(page.getByTestId('corrections')).toContainText('Había fila en el kiosco');
  await expect(page.getByTestId('corrections')).toContainText('Dueño Fatboy');
  await expect(page.getByTestId('effective')).toContainText('+5 min');
  await expect(page.getByTestId('recorded')).toContainText('Entrada'); // el evento físico sigue ahí
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/jornada-detalle.png`, fullPage: true });

  // Historial del empleado: programado vs real, con la corrección y quién la hizo
  await page.goto(`/empleados/${beto.id}`);
  const history = page.getByTestId('attendance-history');
  await expect(history).toContainText('+5 min');
  await expect(history).toContainText('1 · Dueño Fatboy');
});

test('(52) falta: turno publicado sin Entrada → reconciliación → FALTA → se registra la jornada (falta resuelta, no borrada)', async ({ page }) => {
  await login(page);
  const ven = await venecia(page);
  const caro = await newEmployee(page, ven, 'Caro');
  const twoDaysAgo = local(new Date(Date.now() - 2 * 86_400_000)).date;
  await publishedShift(page, ven, caro.id, twoDaysAgo, '07:00', '09:00');

  // el servicio de reconciliación (el mismo comando que se programará en Coolify)
  const out = execFileSync('node', [path.resolve(process.cwd(), '../api/dist/src/cli/reconcile.js')], { env: { ...process.env, DATABASE_URL: process.env.E2E_APP_DATABASE_URL }, encoding: 'utf8' });
  expect(JSON.parse(out.trim().split('\n').pop()!).absences).toBeGreaterThanOrEqual(1);
  // idempotente: otra ejecución no duplica
  execFileSync('node', [path.resolve(process.cwd(), '../api/dist/src/cli/reconcile.js')], { env: { ...process.env, DATABASE_URL: process.env.E2E_APP_DATABASE_URL } });

  await page.getByRole('link', { name: 'Operación' }).click();
  await page.getByRole('link', { name: 'Incidencias' }).click();
  await expect(page.getByRole('heading', { name: 'Incidencias' })).toBeVisible();
  await page.getByLabel('Incidencias').selectOption({ label: 'Falta' });
  const faltaRow = page.getByTestId('incident-FALTA').filter({ hasText: caro.lastName });
  await expect(faltaRow).toHaveCount(1);
  await expect(faltaRow).toContainText(twoDaysAgo);

  await faltaRow.getByRole('button', { name: 'Registrar la jornada que sí ocurrió' }).click();
  const form = page.getByTestId('register-session');
  await form.getByLabel('Motivo', { exact: true }).fill('Sin internet; lista firmada por el encargado');
  await form.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByTestId('incident-FALTA').filter({ hasText: caro.lastName })).toHaveCount(0); // ya no está ABIERTA
  await page.getByLabel('Estado').selectOption({ label: 'Resuelta' });
  await expect(page.getByTestId('incident-FALTA').filter({ hasText: caro.lastName })).toContainText('Corregida');
});

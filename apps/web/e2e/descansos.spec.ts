import { expect, type Page, test } from '@playwright/test';

/** D-92: días de descanso y edad. Alta con descansos, tabla semanal «Descansos», aviso de turno en día de descanso y edición. */
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'dueno@fatboy.example';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'contraseña-larga-123';
const H = { 'x-requested-with': 'checador' };

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Correo').fill(ADMIN_EMAIL);
  await page.getByLabel('Contraseña').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Inicio' })).toBeVisible();
}
const isoWeekday = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() || 7);
const today = () => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function ageOf(birth: string) {
  const [by, bm, bd] = birth.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today().split('-').map(Number) as [number, number, number];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

test('descansos: alta con días y edad, tabla semanal, turno en día de descanso y edición', async ({ page }) => {
  const stamp = Date.now().toString(36);
  const BIRTH = '1990-06-15';
  await login(page);

  // Alta desde la pantalla de empleados con lunes y sábado de descanso
  await page.goto('/empleados');
  await expect(page.getByRole('heading', { name: 'Empleados' })).toBeVisible();
  await page.getByText('Nuevo empleado', { exact: true }).click();
  await page.getByLabel('Número').fill(`D${stamp}`);
  await page.getByLabel('Nombre(s)').fill('Descanso');
  await page.getByLabel('Apellidos').fill(stamp);
  await page.getByLabel('Sucursal principal').selectOption({ label: 'Venecia' });
  await page.getByLabel('Fecha de nacimiento').fill(BIRTH);
  await page.getByLabel('Lunes').check({ force: true });
  await page.getByLabel('Sábado').check({ force: true });
  await page.getByRole('button', { name: 'Crear' }).click();
  await page.getByRole('button', { name: 'Ya lo guardé' }).click();
  const row = page.getByRole('row').filter({ hasText: `Descanso ${stamp}` });
  await expect(row).toContainText('Lun, Sáb');
  await expect(row).toContainText(String(ageOf(BIRTH)));

  // No se pueden marcar los 7 días (el selector se detiene en 6)
  await row.getByRole('link').click();
  await expect(page.getByLabel('Fecha de nacimiento')).toHaveValue(BIRTH);
  for (const d of ['Martes', 'Miércoles', 'Jueves', 'Viernes']) await page.getByLabel(d).check({ force: true });
  await page.getByLabel('Domingo').click({ force: true }); // el séptimo día no se aplica
  await expect(page.getByLabel('Lunes')).toBeChecked();
  await expect(page.getByLabel('Sábado')).toBeChecked();
  const marked = await page.locator('.rest-picker input:checked').count();
  expect(marked).toBe(6);
  await expect(page.getByLabel('Domingo')).not.toBeChecked();
  await page.reload();
  await expect(page.getByLabel('Sábado')).toBeChecked();

  // Tabla semanal
  await page.goto('/descansos');
  await expect(page.getByRole('heading', { name: 'Descansos de la semana' })).toBeVisible();
  await page.getByLabel('Sucursal').selectOption({ label: 'Venecia' });
  const person = page.getByRole('row').filter({ hasText: `Descanso ${stamp}` });
  await expect(person).toBeVisible();
  await expect(person.getByTestId('rest-age')).toHaveText(String(ageOf(BIRTH)));
  // el guardado anterior no se completó (se recargó antes de guardar): siguen lunes y sábado
  await expect(person.locator('td[data-state="REST"]')).toHaveCount(2);
  await expect(person.locator('td[data-state="OFF"]')).toHaveCount(5);
  await expect(page.getByTestId('rest-total-rest')).toBeVisible();
  await expect(page.getByTestId('rest-total-work')).toBeVisible();

  // Un turno en su día de descanso se avisa (no se bloquea)
  const branches = await (await page.request.get('/api/branches')).json();
  const branchId = branches.find((b: { name: string }) => b.name === 'Venecia').id;
  const week = await (await page.request.get(`/api/schedules/week?branchId=${branchId}&date=${today()}`)).json();
  const monday = (week.days as string[]).find((d) => isoWeekday(d) === 1)!;
  const emp = week.employees.find((e: { firstName: string; lastName: string }) => e.firstName === 'Descanso' && e.lastName === stamp);
  const made = await page.request.post('/api/shifts', { headers: H, data: { branchId, employeeId: emp.id, date: monday, startTime: '09:00', endTime: '17:00', reason: 'Prueba E2E' } });
  expect(made.status(), await made.text()).toBe(201);
  await page.reload();
  await page.getByLabel('Sucursal').selectOption({ label: 'Venecia' });
  const conflict = page.getByRole('row').filter({ hasText: `Descanso ${stamp}` }).locator('td.rest-conflict');
  await expect(conflict).toHaveCount(1);
  await expect(conflict).toHaveAttribute('data-state', 'WORK');
  await expect(conflict).toContainText('9a–5p');
  await expect(page.getByRole('row').filter({ hasText: `Descanso ${stamp}` }).locator('td[data-state="REST"]')).toHaveCount(1);
});

test('descansos: editar los días de descanso desde el detalle del empleado se refleja en la tabla', async ({ page }) => {
  const stamp = Date.now().toString(36);
  await login(page);
  const branches = await (await page.request.get('/api/branches')).json();
  const branchId = branches.find((b: { name: string }) => b.name === 'Venecia').id;
  const created = await page.request.post('/api/employees', { headers: H, data: { employeeNumber: `E${stamp}`, firstName: 'Cambio', lastName: stamp, primaryBranchId: branchId } });
  expect(created.status()).toBe(201);
  const id = (await created.json()).employee.id as string;

  await page.goto(`/empleados/${id}`);
  await page.getByLabel('Miércoles').check({ force: true });
  await page.getByLabel('Jueves').check({ force: true });
  const saved = page.waitForResponse((r) => r.url().includes(`/api/employees/${id}`) && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Guardar' }).click();
  expect((await saved).status()).toBe(200);

  await page.goto('/descansos');
  await page.getByLabel('Sucursal').selectOption({ label: 'Venecia' });
  const person = page.getByRole('row').filter({ hasText: `Cambio ${stamp}` });
  await expect(person.locator('td[data-state="REST"]')).toHaveCount(2);
  await expect(person.getByTestId('rest-age')).toHaveText('—');
});

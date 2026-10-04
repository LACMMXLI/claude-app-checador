import { expect, type Page, test } from '@playwright/test';

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

async function newShift(page: Page, who: string, start: string, end: string) {
  await page.getByRole('button', { name: new RegExp(`^Nuevo turno ${who} `) }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Nuevo turno' });
  await dialog.getByLabel('Inicio').fill(start);
  await dialog.getByLabel('Fin', { exact: true }).fill(end);
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  return dialog;
}

test('Fase 2: horario semanal — crear, nocturno, conflicto, copiar semana, publicar, editar con auditoría, cancelar y próximos turnos', async ({ page }) => {
  await login(page);
  const stamp = Date.now().toString().slice(-5);
  // Empleados de Venecia (vía API, con la misma sesión)
  const branches = await (await page.request.get('/api/branches')).json();
  const ven = branches.find((b: { name: string }) => b.name === 'Venecia').id;
  for (const [n, name] of [[`C${stamp}`, 'Carlos'], [`M${stamp}`, 'María']]) {
    const r = await page.request.post('/api/employees', { headers: H, data: { employeeNumber: n, firstName: name, lastName: stamp, primaryBranchId: ven } });
    expect(r.status()).toBe(201);
  }

  await page.getByRole('link', { name: 'Operación' }).click();
  await page.getByRole('link', { name: 'Horario', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Horario semanal' })).toBeVisible();
  await page.getByLabel('Sucursal').selectOption({ label: 'Venecia' });
  await page.getByRole('button', { name: 'Semana siguiente →' }).click();
  await expect(page.getByTestId('schedule-status')).toHaveText('Sin horario');

  // Turno nocturno y turno de día (borrador)
  await newShift(page, 'Carlos', '19:00', '03:00');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '7p–3a (+1)' })).toBeVisible();
  await newShift(page, 'María', '07:00', '15:00');
  await expect(page.getByRole('button', { name: '7a–3p' })).toBeVisible();
  await expect(page.getByTestId('schedule-status')).toHaveText('Borrador');

  // Conflicto: otro turno de Carlos que se traslapa
  const clash = await newShift(page, 'Carlos', '20:00', '23:00');
  await expect(clash.getByRole('alert')).toContainText('traslapa');
  await clash.getByRole('button', { name: '✕' }).click();

  // Copiar a la semana siguiente: vista previa → confirmar
  await page.getByRole('button', { name: 'Semana siguiente →' }).click();
  await expect(page.getByTestId('schedule-status')).toHaveText('Sin horario');
  await page.getByRole('button', { name: 'Copiar semana anterior' }).click();
  await expect(page.getByRole('status')).toContainText('Vista previa');
  await expect(page.getByRole('status')).toContainText('Turnos creados: 2');
  await page.getByRole('status').getByRole('button', { name: 'Copiar semana anterior' }).click();
  await expect(page.getByRole('status')).toContainText('Resultado de la copia');
  await expect(page.getByRole('button', { name: '7p–3a (+1)' })).toBeVisible();

  // Publicar
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Publicar horario' }).click();
  await expect(page.getByTestId('schedule-status')).toHaveText('Publicado');

  // Editar un turno publicado y ver su auditoría
  await page.getByRole('button', { name: '7a–3p' }).click();
  const edit = page.getByRole('dialog', { name: 'Turno' });
  await edit.getByLabel('Fin', { exact: true }).fill('16:00');
  await edit.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('button', { name: '7a–4p' })).toBeVisible();
  await page.getByRole('button', { name: '7a–4p' }).click();
  await page.getByText(/Historial/).click();
  await expect(page.getByRole('dialog', { name: 'Turno' })).toContainText('shift.updated');
  await expect(page.getByRole('dialog', { name: 'Turno' })).toContainText('07:00–15:00 → 07:00–16:00');
  await expect(page.getByRole('button', { name: 'Quitar del borrador' })).toHaveCount(0); // publicado: solo cancelar

  // Cancelar con motivo
  await page.getByRole('dialog', { name: 'Turno' }).getByLabel(/Motivo/).fill('Evento privado');
  await page.getByRole('button', { name: 'Cancelar turno' }).click();
  await expect(page.locator('.shift.cancelled')).toHaveText('7a–4p');
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/horario.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/horario-movil.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
  }

  // Próximos turnos del empleado
  await page.getByRole('link', { name: 'Equipo' }).click();
  await page.getByRole('link', { name: `Carlos ${stamp}` }).click();
  await expect(page.getByRole('heading', { name: 'Próximos turnos' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '7p–3a (+1)' })).toHaveCount(2);
  await expect(page.getByRole('cell', { name: 'Publicado' })).toHaveCount(1);
  await expect(page.getByRole('cell', { name: 'Borrador' })).toHaveCount(1);
});

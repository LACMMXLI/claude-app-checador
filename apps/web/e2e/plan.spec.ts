import { expect, test } from '@playwright/test';

const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'contraseña-larga-123';
const H = { 'x-requested-with': 'checador' };

async function login(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Inicio' })).toBeVisible();
}

test('(61) Mi plan: Fatboy (Avanzado) ve su uso y funciones; el negocio BÁSICO ve candados y topes con mensajes claros', async ({ page, browser }) => {
  // Avanzado
  await login(page, process.env.E2E_ADMIN_EMAIL ?? 'dueno@fatboy.example');
  await page.getByRole('link', { name: 'Configuración' }).click();
  await page.getByRole('link', { name: 'Plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mi plan' })).toBeVisible();
  await expect(page.getByTestId('plan-name')).toHaveText('Avanzado');
  await expect(page.getByTestId('plan-status')).toHaveText('Activo');
  await expect(page.getByTestId('plan-features').getByText('Incluida')).toHaveCount(2);
  await expect(page.getByTestId('usage-branches')).toContainText('/ 10');
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/plan-avanzado.png`, fullPage: true });

  // Básico: funciones bloqueadas y tope de sucursales
  const ctx = await browser.newContext();
  const basic = await ctx.newPage();
  await login(basic, 'basico@cafe.example');
  await basic.getByRole('link', { name: 'Configuración' }).click();
  await basic.getByRole('link', { name: 'Plan', exact: true }).click();
  await expect(basic.getByTestId('plan-name')).toHaveText('Básico');
  await expect(basic.getByTestId('usage-branches')).toHaveText('1 / 2');
  await expect(basic.getByTestId('plan-features').getByText('No incluida en tu plan')).toHaveCount(2);
  if (process.env.E2E_SCREENSHOTS) await basic.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/plan-basico.png`, fullPage: true });

  // plantillas: aviso en lugar de la pantalla
  await basic.goto('/plantillas');
  await expect(basic.getByTestId('feature-locked')).toContainText('Esta función no está en tu plan');
  // reportes: se consulta, pero la exportación está bloqueada
  await basic.goto('/reportes');
  await expect(basic.getByTestId('export-locked')).toBeVisible();
  await expect(basic.getByTestId('export-xlsx')).toHaveCount(0);
  // la API lo exige igual aunque se intente por fuera de la pantalla
  const exp = await basic.request.post('/api/reports/export', { headers: H, data: { format: 'csv', filters: { report: 'summary', period: 'today' } } });
  expect(exp.status()).toBe(403);
  expect((await exp.json()).error.code).toBe('FEATURE_NOT_IN_PLAN');

  // sucursales: la segunda cabe; la tercera, no
  await basic.getByRole('link', { name: 'Configuración' }).click();
  await basic.getByText('Nueva sucursal', { exact: true }).click();
  await basic.getByLabel('Código').fill('DOS');
  await basic.getByLabel('Nombre', { exact: true }).fill('Segunda');
  await basic.getByRole('button', { name: 'Crear' }).click();
  await expect(basic.getByRole('cell', { name: 'Segunda' })).toBeVisible();
  await basic.getByLabel('Código').fill('TRES');
  await basic.getByLabel('Nombre', { exact: true }).fill('Tercera');
  await basic.getByRole('button', { name: 'Crear' }).click();
  await expect(basic.locator('p.error')).toContainText('límite de sucursales de tu plan');
  await expect(basic.getByRole('cell', { name: 'Tercera' })).toHaveCount(0);
  await ctx.close();
});

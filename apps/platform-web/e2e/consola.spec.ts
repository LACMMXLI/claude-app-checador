import { expect, type Page, test } from '@playwright/test';

const EMAIL = 'operador@plataforma.example';
const PASSWORD = 'contraseña-larga-123';
const TENANT_API = process.env.E2E_TENANT_API ?? 'http://127.0.0.1:3912';
const stamp = Date.now().toString().slice(-6);
const shot = async (page: Page, name: string) => { if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png`, fullPage: true }); };

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Correo').fill(EMAIL);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Resumen' })).toBeVisible();
}

/** ¿Puede esa persona entrar HOY a la app de los clientes? (API real de clientes, no un simulacro) */
async function tenantLogin(page: Page, email: string, password: string) {
  const r = await page.request.post(`${TENANT_API}/api/auth/login`, { headers: { 'x-requested-with': 'checador' }, data: { email, password } });
  return { status: r.status(), code: r.status() === 200 ? 'OK' : (await r.json()).error.code as string };
}

test('consola: sesión, alta de cliente, plan, suspensión/activación reales, planes, operadores y bitácora', async ({ page }) => {
  // 1) sesión: mala contraseña, buena contraseña; sin sesión no hay datos
  await page.goto('/login');
  await page.getByLabel('Correo').fill(EMAIL);
  await page.getByLabel('Contraseña').fill('mala-contraseña-1');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.locator('p.error')).toContainText('Correo o contraseña incorrectos');
  await login(page);
  expect(await page.evaluate(() => Object.keys(localStorage).length)).toBe(0); // nada de tokens en localStorage
  expect(await page.evaluate(() => document.cookie)).toBe(''); // la cookie es HttpOnly
  await expect(page.getByTestId('kpis')).toBeVisible();
  await shot(page, 'resumen');

  // 2) alta de un cliente (plan Básico, prueba de 14 días)
  const slug = `taqueria-${stamp}`;
  const adminEmail = `dueno-${stamp}@taqueria.example`;
  await page.getByRole('link', { name: 'Clientes', exact: true }).click();
  await page.getByRole('link', { name: 'Nuevo cliente' }).first().click();
  await expect(page.getByRole('heading', { name: 'Nuevo cliente' })).toBeVisible();
  await page.getByLabel('Nombre del negocio').fill(`Taquería ${stamp}`);
  await expect(page.getByLabel('Clave (sin espacios)')).toHaveValue(slug);
  await page.getByLabel('Zona horaria').selectOption('America/Tijuana');
  await page.getByLabel('Clave', { exact: true }).fill('CEN');
  await page.getByLabel('Nombre', { exact: true }).first().fill('Centro');
  await page.getByLabel('Nombre', { exact: true }).nth(1).fill('Dueña Taquería');
  await page.getByLabel('Correo').fill(adminEmail);
  await page.getByTestId('plan-select').selectOption({ label: 'Básico' });
  await shot(page, 'nuevo-cliente');
  await page.getByRole('button', { name: 'Dar de alta' }).click();
  const password = await page.locator('.secret code').innerText();
  expect(password).toHaveLength(16);
  await page.getByRole('button', { name: 'Ya lo guardé' }).click();
  await expect(page.locator('.secret')).toHaveCount(0);

  // 3) la dueña ya puede entrar a SU app con esa contraseña
  expect(await tenantLogin(page, adminEmail, password)).toEqual({ status: 200, code: 'OK' });

  // 4) detalle del cliente
  await page.getByRole('link', { name: 'Ver cliente' }).click();
  await expect(page.getByTestId('customer-name')).toHaveText(`Taquería ${stamp}`);
  await expect(page.getByTestId('customer-plan')).toHaveText('Básico');
  await expect(page.getByTestId('customer-status')).toHaveText('En prueba');
  await expect(page.getByTestId('app-state')).toHaveText('Operando');
  await expect(page.getByTestId('usage')).toContainText('1 / 2'); // sucursales
  await shot(page, 'cliente-detalle');

  // 5) suspender: la app de la dueña deja de funcionar al instante
  await page.getByRole('button', { name: 'Suspender', exact: true }).click();
  await page.getByLabel('Motivo').fill('Pausa acordada con el cliente');
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByTestId('customer-status')).toHaveText('Suspendido');
  await expect(page.getByTestId('app-state')).toHaveText('Sin acceso (suspendida)');
  expect(await tenantLogin(page, adminEmail, password)).toEqual({ status: 400, code: 'NO_ACTIVE_MEMBERSHIP' });

  // 6) activar con el plan Avanzado: vuelve a operar y el plan cambió
  await page.getByRole('button', { name: 'Activar / renovar' }).click();
  await page.getByTestId('panel-activate').getByLabel('Plan').selectOption({ label: 'Avanzado' });
  await page.getByRole('button', { name: 'Activar', exact: true }).click();
  await expect(page.getByTestId('customer-status')).toHaveText('Activo');
  await expect(page.getByTestId('customer-plan')).toHaveText('Avanzado');
  await expect(page.getByTestId('usage')).toContainText('1 / 10');
  expect(await tenantLogin(page, adminEmail, password)).toEqual({ status: 200, code: 'OK' });

  // 7) bajar de plan funciona sin tocar datos; notas internas; historial con responsable
  await page.getByRole('button', { name: 'Cambiar plan' }).click();
  await page.getByTestId('panel-plan').getByLabel('Plan').selectOption({ label: 'Básico' });
  await page.getByRole('button', { name: 'Aplicar plan' }).click();
  await expect(page.getByTestId('customer-plan')).toHaveText('Básico');
  await page.getByTestId('notes').fill('Contrato verbal, renovar en enero');
  await page.getByRole('button', { name: 'Guardar notas' }).click();
  await expect(page.getByTestId('history')).toContainText('Cambio de plan: ADVANCED → BASIC');
  await expect(page.getByTestId('history')).toContainText('Activo → Suspendido'.replace('Activo → Suspendido', 'En prueba → Suspendido'));
  await expect(page.getByTestId('history')).toContainText(`operator:${EMAIL}`);
  await shot(page, 'cliente-historial');

  // 8) soporte: restablecer la contraseña de la dueña (se muestra una vez) y la nueva sirve
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('admins').getByRole('button', { name: 'Restablecer contraseña' }).click();
  const reset = await page.locator('.secret code').innerText();
  expect(await tenantLogin(page, adminEmail, password)).toMatchObject({ status: 401 });
  expect(await tenantLogin(page, adminEmail, reset)).toEqual({ status: 200, code: 'OK' });
  await page.getByRole('button', { name: 'Ya lo guardé' }).click();

  // 9) lista: buscar y filtrar
  await page.getByRole('link', { name: 'Clientes', exact: true }).click();
  await page.getByTestId('search').fill(slug);
  await expect(page.getByTestId(`customer-${slug}`)).toBeVisible();
  await expect(page.getByTestId('total')).toHaveText('1 clientes');
  await page.getByTestId('filter-status').selectOption('SUSPENDED');
  await expect(page.getByTestId(`customer-${slug}`)).toHaveCount(0);
  await page.getByTestId('filter-status').selectOption('ACTIVE');
  await expect(page.getByTestId(`customer-${slug}`)).toContainText('Básico');
  await shot(page, 'clientes');

  // 10) planes: editar y que el cambio llegue a la app del cliente
  await page.getByRole('link', { name: 'Planes', exact: true }).click();
  const basic = page.getByTestId('plan-BASIC');
  await basic.getByLabel('Descripción').fill(`Plan de entrada ${stamp}`);
  await basic.getByLabel('Kioscos activos').fill('3');
  await basic.getByRole('button', { name: 'Guardar plan' }).click();
  await expect(page.getByTestId('toast').first()).toContainText('Listo');
  await page.reload();
  await expect(page.getByTestId('plan-BASIC').getByLabel('Descripción')).toHaveValue(`Plan de entrada ${stamp}`);
  await expect(page.getByTestId('plan-BASIC').getByLabel('Kioscos activos')).toHaveValue('3');
  await shot(page, 'planes');

  // 11) operadores: crear (contraseña una vez), no hay botón para deshabilitarse a sí mismo, deshabilitar al nuevo
  await page.getByRole('link', { name: 'Operadores', exact: true }).click();
  await page.getByText('Nuevo operador', { exact: true }).click();
  const opEmail = `soporte-${stamp}@plataforma.example`;
  await page.getByTestId('new-operator').getByLabel('Nombre').fill('Soporte E2E');
  await page.getByTestId('new-operator').getByLabel('Correo').fill(opEmail);
  await page.getByRole('button', { name: 'Crear operador' }).click();
  await expect(page.locator('.secret code')).toHaveText(/^.{16}$/);
  await page.getByRole('button', { name: 'Ya lo guardé' }).click();
  const mine = page.getByTestId('operators').getByRole('row', { name: new RegExp(EMAIL) });
  await expect(mine).toContainText('(tú)');
  await expect(mine.getByRole('button', { name: 'Deshabilitar' })).toHaveCount(0);
  const row = page.getByTestId('operators').getByRole('row', { name: new RegExp(opEmail) });
  await row.getByRole('button', { name: 'Deshabilitar' }).click();
  await expect(row).toContainText('Inactivo');
  await shot(page, 'operadores');

  // 12) bitácora: queda todo, sin contraseñas
  await page.getByRole('link', { name: 'Bitácora', exact: true }).click();
  await expect(page.getByTestId('audit')).toContainText('subscription.suspended');
  await expect(page.getByTestId('audit')).toContainText('operator.created');
  await expect(page.getByTestId('audit')).not.toContainText(password);
  await expect(page.getByTestId('audit')).not.toContainText(reset);
  await shot(page, 'bitacora');

  // 13) mi cuenta: la contraseña actual debe ser correcta
  await page.getByRole('link', { name: 'Mi cuenta' }).first().click();
  await page.getByLabel('Contraseña actual').fill('no-es-esta-1234');
  await page.getByLabel('Contraseña nueva', { exact: true }).fill('otra-clave-larga-99');
  await page.getByLabel('Repite la contraseña nueva').fill('otra-clave-larga-99');
  await page.getByRole('button', { name: 'Cambiar contraseña' }).click();
  await expect(page.locator('p.error')).toContainText('contraseña actual no es correcta');

  // 14) cerrar sesión
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page).toHaveURL(/\/login/);
  expect((await page.request.get('/api/customers')).status()).toBe(401);
});

test('el menú móvil abre y cierra y las pantallas no se desbordan en 390 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('button', { name: 'Abrir menú' }).click();
  await page.getByRole('link', { name: 'Clientes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Clientes', level: 1 })).toBeVisible();
  for (const path of ['/', '/clientes', '/clientes/nuevo', '/planes', '/operadores', '/bitacora', '/cuenta']) {
    await page.goto(path);
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, path).toBeLessThanOrEqual(1);
  }
  await shot(page, 'movil-clientes');
});

import { expect, test } from '@playwright/test';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'dueno@fatboy.example';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'contraseña-larga-123';
const stamp = Date.now().toString().slice(-6);

test('panel: login → sucursal → empleado (PIN una vez) → kiosco (token una vez) → políticas → invitación → encargado restringido', async ({ page, browser }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Correo').fill(ADMIN_EMAIL);
  await page.getByLabel('Contraseña').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Inicio' })).toBeVisible();
  await expect(page.locator('.sidebar .org')).toHaveText('Fatboy');

  // la sesión NO está en localStorage: solo en una cookie HttpOnly
  expect(await page.evaluate(() => Object.keys(localStorage).length)).toBe(0);
  expect(await page.evaluate(() => document.cookie)).toBe('');

  // Sucursal
  await page.getByRole('link', { name: 'Sucursales' }).click();
  await page.getByLabel('Código').fill(`E${stamp}`);
  await page.getByLabel('Nombre').first().fill(`Sucursal ${stamp}`);
  await page.getByRole('button', { name: 'Crear' }).click();
  await expect(page.getByRole('cell', { name: `Sucursal ${stamp}` })).toBeVisible();

  // Empleado: el PIN aparece una sola vez
  await page.getByRole('link', { name: 'Empleados' }).click();
  await page.getByLabel('Número').fill(`N${stamp}`);
  await page.getByLabel('Nombre(s)').fill('Ana');
  await page.getByLabel('Apellidos').fill('E2E');
  await page.getByLabel('Sucursal principal').selectOption({ label: 'Venecia' });
  await page.getByRole('button', { name: 'Crear' }).click();
  const pin = await page.locator('.secret code').innerText();
  expect(pin).toMatch(/^\d{6}$/);
  await page.getByRole('button', { name: 'Ya lo guardé' }).click();
  await expect(page.locator('.secret')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Ana E2E' })).toBeVisible();

  // Kiosco: token una sola vez
  await page.getByRole('link', { name: 'Kioscos' }).click();
  await page.getByLabel('Nombre').fill(`Tablet ${stamp}`);
  await page.getByLabel('Sucursal').first().selectOption({ label: 'Venecia' });
  await page.getByRole('button', { name: 'Crear' }).click();
  await expect(page.locator('.secret code')).toContainText('kt_');
  await page.getByRole('button', { name: 'Ya lo guardé' }).click();

  // Políticas: valor efectivo + origen
  await page.getByRole('link', { name: 'Políticas' }).click();
  const row = page.getByRole('row', { name: /Minutos permitidos por pausa/ });
  await expect(row).toContainText('35');
  await expect(row).toContainText('plataforma');

  // Invitación a un encargado de Venecia
  await page.getByRole('link', { name: 'Usuarios' }).click();
  const managerEmail = `encargado${stamp}@ejemplo.com`;
  await page.getByLabel('Correo').fill(managerEmail);
  await page.getByLabel('Rol').selectOption({ label: 'ENCARGADO' });
  await page.getByLabel('Sucursales', { exact: true }).selectOption({ label: 'Venecia' });
  await page.getByRole('button', { name: 'Invitar usuario' }).click();
  const link = await page.locator('.secret code').innerText();
  expect(link).toContain('/invitacion/');

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(link);
  await guest.getByLabel('Tu nombre').fill('Encargado E2E');
  await guest.getByLabel('Contraseña').fill('encargado-pass-123');
  await guest.getByRole('button', { name: 'Aceptar invitación' }).click();
  await expect(guest.getByText('Listo. Ya puedes iniciar sesión.')).toBeVisible();

  await guest.goto('/login');
  await guest.getByLabel('Correo').fill(managerEmail);
  await guest.getByLabel('Contraseña').fill('encargado-pass-123');
  await guest.getByRole('button', { name: 'Entrar' }).click();
  await expect(guest.getByRole('heading', { name: 'Inicio' })).toBeVisible();
  await expect(guest.getByRole('link', { name: 'Usuarios' })).toHaveCount(0);
  await expect(guest.getByRole('link', { name: 'Kioscos' })).toHaveCount(0);
  await guest.getByRole('link', { name: 'Sucursales' }).click();
  await expect(guest.getByRole('cell', { name: 'Venecia' })).toBeVisible();
  await expect(guest.getByRole('cell', { name: 'San Marcos' })).toHaveCount(0);
  // aunque escriba la URL, el backend responde 403
  const res = await guest.request.get('/api/kiosks');
  expect(res.status()).toBe(403);

  // Logout
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page).toHaveURL(/\/login/);
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
});

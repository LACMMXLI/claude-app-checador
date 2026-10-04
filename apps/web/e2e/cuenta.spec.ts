import { expect, test } from '@playwright/test';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'dueno@fatboy.example';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'contraseña-larga-123';
const H = { 'x-requested-with': 'checador' };

/** D-80 · Una persona cambia su PROPIA contraseña desde "Mi cuenta"; las demás sesiones se cierran. */
test('(60) Mi cuenta: cambiar la propia contraseña, aviso de éxito y cierre de las demás sesiones', async ({ page, browser }) => {
  // preparar un usuario nuevo (así no se toca la contraseña del administrador que usan las demás pruebas)
  await page.goto('/login');
  await page.getByLabel('Correo').fill(ADMIN_EMAIL);
  await page.getByLabel('Contraseña').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Inicio' })).toBeVisible();
  const roles = await (await page.request.get('/api/roles')).json();
  const encargado = roles.find((r: { name: string }) => r.name === 'ENCARGADO').id;
  const branches = await (await page.request.get('/api/branches')).json();
  const email = `cuenta-${Date.now()}@fatboy.example`;
  const inv = await page.request.post('/api/invitations', { headers: H, data: { email, roleId: encargado, scope: { type: 'BRANCHES', branchIds: [branches[0].id] } } });
  expect(inv.status(), await inv.text()).toBe(201);
  const { token } = await inv.json();
  const oldPassword = 'clave-inicial-segura-1';
  const newPassword = 'clave-nueva-segura-22';
  expect((await page.request.post(`/api/auth/invitations/${token}/accept`, { headers: H, data: { password: oldPassword, displayName: 'Persona Cuenta' } })).status()).toBe(200);

  const login = async (context: import('@playwright/test').BrowserContext, password: string) => {
    const p = await context.newPage();
    await p.goto('/login');
    await p.getByLabel('Correo').fill(email);
    await p.getByLabel('Contraseña').fill(password);
    await p.getByRole('button', { name: 'Entrar' }).click();
    return p;
  };

  // dos sesiones de la misma persona: la de "otro dispositivo" y la que cambiará la contraseña
  const other = await login(await browser.newContext(), oldPassword);
  await expect(other.getByRole('heading', { name: 'Inicio' })).toBeVisible();
  const mine = await login(await browser.newContext(), oldPassword);
  await expect(mine.getByRole('heading', { name: 'Inicio' })).toBeVisible();

  await mine.getByRole('link', { name: 'Mi cuenta' }).click();
  await expect(mine.getByRole('heading', { name: 'Mi cuenta' })).toBeVisible();
  await expect(mine.locator('.profile').getByText(email)).toBeVisible();
  const form = mine.getByTestId('password-form');

  // contraseña actual incorrecta: mensaje claro, nada cambia
  await form.getByLabel('Contraseña actual').fill('no-es-esta-clave');
  await form.getByLabel('Nueva contraseña', { exact: true }).fill(newPassword);
  await form.getByLabel('Confirmar nueva contraseña').fill(newPassword);
  await form.getByRole('button', { name: 'Cambiar contraseña' }).click();
  await expect(mine.getByText('La contraseña actual no es correcta.')).toBeVisible();

  // las nuevas no coinciden
  await form.getByLabel('Contraseña actual').fill(oldPassword);
  await form.getByLabel('Confirmar nueva contraseña').fill(`${newPassword}x`);
  await form.getByRole('button', { name: 'Cambiar contraseña' }).click();
  await expect(mine.getByText('Las contraseñas nuevas no coinciden.')).toBeVisible();

  // correcto
  await form.getByLabel('Confirmar nueva contraseña').fill(newPassword);
  await form.getByRole('button', { name: 'Cambiar contraseña' }).click();
  await expect(mine.getByTestId('toast')).toContainText('Contraseña actualizada');
  if (process.env.E2E_SCREENSHOTS) await mine.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/cuenta-cambio.png`, fullPage: true });

  // esta sesión sigue; la del otro dispositivo se cerró; la contraseña anterior ya no sirve
  await mine.reload();
  await expect(mine.getByRole('heading', { name: 'Mi cuenta' })).toBeVisible();
  await other.reload();
  await expect(other).toHaveURL(/\/login/);
  const stale = await login(await browser.newContext(), oldPassword);
  await expect(stale.getByText('Correo o contraseña incorrectos.')).toBeVisible();
  const fresh = await login(await browser.newContext(), newPassword);
  await expect(fresh.getByRole('heading', { name: 'Inicio' })).toBeVisible();
});

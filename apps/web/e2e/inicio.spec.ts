import fs from 'node:fs';
import { expect, test } from '@playwright/test';

/** Inicio en escritorio: toda la información cabe en una sola vista (sin scroll de la página) en pantallas habituales. */
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'dueno@fatboy.example';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'contraseña-larga-123';
const SHOTS = process.env.E2E_SCREENSHOTS;

const SCREENS = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
] as const;

test('Inicio en escritorio cabe en una vista, sin scroll de página ni elementos fuera de pantalla', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Correo').fill(ADMIN_EMAIL);
  await page.getByLabel('Contraseña').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Inicio' })).toBeVisible();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  for (const s of SCREENS) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.goto('/');
    await expect(page.getByTestId('kpis')).toBeVisible();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await page.waitForTimeout(400);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/inicio-compacto.${s.name}.png` });
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const box = (sel: string) => {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) } : null;
      };
      return {
        scroll: de.scrollHeight - window.innerHeight,
        hscroll: de.scrollWidth - window.innerWidth,
        kpis: box('[data-testid=kpis]'), timeline: box('[data-testid=timeline]'), attention: box('[data-testid=attention]'), branches: box('[data-testid=branches-card]'),
        vw: window.innerWidth, vh: window.innerHeight,
      };
    });
    const where = `${s.name} ${JSON.stringify(m)}`;
    expect(m.scroll, `scroll vertical de la página ${where}`).toBeLessThanOrEqual(1);
    expect(m.hscroll, `scroll horizontal ${where}`).toBeLessThanOrEqual(1);
    for (const k of ['kpis', 'timeline', 'attention', 'branches'] as const) {
      const b = m[k];
      expect(b, `${k} existe ${where}`).not.toBeNull();
      expect(b!.bottom, `${k} dentro de la pantalla ${where}`).toBeLessThanOrEqual(m.vh + 1);
      expect(b!.right, `${k} dentro del ancho ${where}`).toBeLessThanOrEqual(m.vw + 1);
    }
  }
});

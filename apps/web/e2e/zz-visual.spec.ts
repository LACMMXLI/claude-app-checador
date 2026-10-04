import fs from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

/**
 * Auditoría visual (no es una prueba funcional): recorre las pantallas del panel y los estados del kiosco en tres anchos
 * y dos esquemas de color, guarda capturas y registra problemas medibles (desbordes, texto cortado, elementos fuera de
 * pantalla, contraste). Solo se registra con E2E_VISUAL=1; se ejecuta al final para aprovechar los datos que dejan las demás.
 */
const DIR = process.env.E2E_SCREENSHOTS ?? '/tmp/shots';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'dueno@fatboy.example';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'contraseña-larga-123';
const H = { 'x-requested-with': 'checador' };

const VIEWPORTS = [
  { name: 'movil', width: 390, height: 844 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'escritorio', width: 1440, height: 900 },
] as const;
const SCHEMES = ['light', 'dark'] as const;

const PAGES: { slug: string; path: string; open?: string }[] = [
  { slug: 'inicio', path: '/' },
  { slug: 'asistencia', path: '/asistencia' },
  { slug: 'jornadas', path: '/jornadas' },
  { slug: 'incidencias', path: '/incidencias' },
  { slug: 'solicitudes', path: '/solicitudes' },
  { slug: 'horario', path: '/horario' },
  { slug: 'plantillas', path: '/plantillas' },
  { slug: 'empleados', path: '/empleados' },
  { slug: 'usuarios', path: '/usuarios' },
  { slug: 'kioscos', path: '/kioscos' },
  { slug: 'reportes', path: '/reportes' },
  { slug: 'sucursales', path: '/sucursales' },
  { slug: 'politicas', path: '/politicas' },
  { slug: 'auditoria', path: '/auditoria' },
  { slug: 'cuenta', path: '/cuenta' },
];

/** Se ejecuta DENTRO de la página: devuelve problemas medibles. */
function audit(): string[] {
  const out: string[] = [];
  const vw = window.innerWidth;
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) out.push(`DESBORDE-PAGINA scrollWidth=${doc.scrollWidth} > ${doc.clientWidth}`);
  const desc = (el: Element) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${cls}«${(el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 36)}»`;
  };
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const closedDrawer = (el: Element) => vw <= 860 && el.closest('.sidebar, .scrim') !== null && !document.querySelector('.shell.open');
  const inScroller = (el: Element) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true;
    }
    return false;
  };
  const seen = new Set<string>();
  const add = (s: string) => { if (!seen.has(s)) { seen.add(s); out.push(s); } };

  // contenedores con scroll horizontal (informativo: tablas anchas dentro de su tarjeta)
  document.querySelectorAll('.card, .tabs, .table-scroll').forEach((el) => {
    if (el.scrollWidth > el.clientWidth + 1 && shown(el)) add(`INFO-SCROLL-HORIZONTAL ${desc(el)} ${el.scrollWidth}>${el.clientWidth}`);
  });

  const colorToRgba = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    return (v: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    };
  })();
  const lum = ([r, g, b]: number[]) => {
    const f = (x: number) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
  };
  const background = (el: Element): [number, number, number] => {
    const stack: [number, number, number, number][] = [];
    for (let p: Element | null = el; p; p = p.parentElement) {
      const bg = colorToRgba(getComputedStyle(p).backgroundColor);
      if (bg[3] > 0) { stack.push(bg); if (bg[3] >= 1) break; }
    }
    let base: [number, number, number] = [255, 255, 255];
    for (const bg of stack.reverse()) base = [0, 1, 2].map((i) => bg[i]! * bg[3] + base[i]! * (1 - bg[3])) as [number, number, number];
    return base;
  };

  // claves de traducción que se cuelan en pantalla (ej. "policy.shiftMinMinutes"); el código de acciones de auditoría va en <code>
  const keyLike = /^(policy|nav|common|att|live|req|incident|kiosk|kiosks|users|employees|branches|reports|schedule|dashboard|account|audit|state|login|secret|toast|mine|history|policies)\.[A-Za-z][A-Za-z.]*$/;
  document.querySelectorAll('body *').forEach((el) => {
    if (el.children.length === 0 && el.tagName !== 'CODE' && keyLike.test((el.textContent ?? '').trim())) add(`CLAVE-SIN-TRADUCIR ${desc(el)}`);
  });

  const all = Array.from(document.body.querySelectorAll('*'));
  for (const el of all) {
    if (!shown(el) || closedDrawer(el) || el.closest('.toasts, .sr-only') || (vw <= 760 && el.closest('table.week thead'))) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const interactive = el.matches('a, button, input, select, textarea, summary');

    // fuera de pantalla (a la derecha o a la izquierda), salvo dentro de un contenedor con scroll
    if (!inScroller(el) && (r.right > vw + 1 || r.left < -1) && (interactive || (el.textContent ?? '').trim())) {
      if (el.children.length === 0 || interactive) add(`FUERA-DE-PANTALLA ${desc(el)} left=${Math.round(r.left)} right=${Math.round(r.right)} vw=${vw}`);
    }
    // texto cortado: overflow oculto con contenido más ancho, o controles con texto que no cabe
    if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip' || el.matches('button, a.tab, .badge, .state, .flag, .chip')) && el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible' && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') {
      add(`TEXTO-CORTADO ${desc(el)} scrollWidth=${el.scrollWidth} clientWidth=${el.clientWidth}`);
    }
    if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) add(`TEXTO-TRUNCADO-ELIPSIS ${desc(el)}`);
    // contenido de botones/etiquetas que sobresale de su caja
    if (el.matches('button, .badge, .state, .flag, .chip, .kpi, .tabs a') && (el.scrollHeight > el.clientHeight + 2)) add(`CONTENIDO-SOBRESALE-VERTICAL ${desc(el)} ${el.scrollHeight}>${el.clientHeight}`);

    // contraste (solo elementos con texto propio)
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0);
    if (own && !el.closest(':disabled') && !el.closest('[aria-hidden="true"]')) {
      let op = 1;
      for (let p: Element | null = el; p; p = p.parentElement) op *= Number(getComputedStyle(p).opacity);
      const fg = colorToRgba(cs.color);
      const bg = background(el);
      const a = fg[3] * op;
      const blended = [0, 1, 2].map((i) => fg[i]! * a + bg[i]! * (1 - a));
      const L1 = lum(blended);
      const L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const px = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 700;
      const need = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5;
      if (ratio < need) add(`CONTRASTE ${ratio.toFixed(2)}<${need} ${desc(el)} color=${cs.color}`);
    }
  }
  return out;
}

async function settle(page: Page) {
  await page.locator('.skeleton').first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(900); // animaciones de entrada
}

if (process.env.E2E_VISUAL) {
  test('auditoría visual: panel (3 anchos × 2 esquemas)', async ({ page }) => {
    test.setTimeout(900_000);
    fs.mkdirSync(DIR, { recursive: true });
    const issues: Record<string, string[]> = {};
    await page.goto('/login');
    await page.getByLabel('Correo').fill(ADMIN_EMAIL);
    await page.getByLabel('Contraseña').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('heading', { name: 'Inicio' })).toBeVisible();

    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        for (const p of PAGES) {
          await page.goto(p.path);
          await settle(page);
          const key = `${p.slug}.${vp.name}.${scheme}`;
          issues[key] = await page.evaluate(audit);
          await page.screenshot({ path: `${DIR}/${key}.png`, fullPage: true });

          // variantes con el formulario/detalle abierto
          const variant = async (suffix: string, open: () => Promise<boolean>) => {
            if (!(await open())) return;
            await page.waitForTimeout(500);
            issues[`${key}.${suffix}`] = await page.evaluate(audit);
            await page.screenshot({ path: `${DIR}/${key}.${suffix}.png`, fullPage: true });
          };
          if (['empleados', 'usuarios', 'kioscos', 'plantillas', 'sucursales'].includes(p.slug)) {
            await variant('alta', async () => {
              const s = page.locator('details.disclosure > summary').first();
              if ((await s.count()) === 0) return false;
              await s.click();
              return true;
            });
          }
          if (p.slug === 'incidencias') {
            await variant('resolver', async () => {
              const b = page.getByRole('button', { name: 'Resolver' }).first();
              if ((await b.count()) === 0) return false;
              await b.click();
              return true;
            });
          }
          if (p.slug === 'solicitudes') {
            await variant('detalle', async () => {
              await page.getByLabel('Estado').selectOption({ label: 'Todos' });
              await page.waitForTimeout(800);
              const b = page.getByTestId('requests').locator('button.link').first();
              if ((await b.count()) === 0) return false;
              await b.click();
              return true;
            });
          }
        }
      }
    }
    fs.writeFileSync(`${DIR}/issues-panel.json`, JSON.stringify(issues, null, 1));
    const n = Object.values(issues).reduce((a, l) => a + l.filter((x) => !x.startsWith('INFO')).length, 0);
    console.log(`AUDITORIA-PANEL problemas=${n} pantallas=${Object.keys(issues).length}`);
  });

  test('auditoría visual: estados del kiosco (3 anchos × 2 esquemas)', async ({ page, browser }) => {
    test.setTimeout(600_000);
    fs.mkdirSync(DIR, { recursive: true });
    const issues: Record<string, string[]> = {};
    await page.goto('/login');
    await page.getByLabel('Correo').fill(ADMIN_EMAIL);
    await page.getByLabel('Contraseña').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('heading', { name: 'Inicio' })).toBeVisible();
    const branches = await (await page.request.get('/api/branches')).json();
    const ven = branches.find((b: { name: string }) => b.name === 'Venecia').id;
    const created = await page.request.post('/api/kiosks', { headers: H, data: { name: `Visual ${Date.now()}`, branchId: ven } });
    const { token } = await created.json();

    for (const scheme of SCHEMES) {
      for (const vp of VIEWPORTS) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme });
        const kiosk = await context.newPage();
        await kiosk.goto('/kiosco');
        // 0) activación (la credencial se consume una vez por contexto: se crea un kiosco por combinación)
        const k = await page.request.post('/api/kiosks', { headers: H, data: { name: `Visual ${vp.name}-${scheme}-${Date.now()}`, branchId: ven } });
        const t = (await k.json()).token ?? token;
        await expect(kiosk.getByRole('heading', { name: 'Activar este kiosco' })).toBeVisible();
        const snap = async (state: string) => {
          await kiosk.waitForTimeout(700);
          const key = `kiosco-${state}.${vp.name}.${scheme}`;
          issues[key] = await kiosk.evaluate(audit);
          await kiosk.screenshot({ path: `${DIR}/${key}.png`, fullPage: true });
        };
        await snap('activar');
        await kiosk.getByLabel('Token o código').fill(t);
        await kiosk.getByRole('button', { name: 'Activar' }).click();
        await expect(kiosk.getByRole('heading', { name: 'Escribe tu código' })).toBeVisible();

        await snap('pin-vacio');
        for (const d of '123') await kiosk.getByRole('button', { name: d, exact: true }).click();
        await snap('pin-incompleto');
        await kiosk.getByRole('button', { name: 'Borrar' }).click();
        await expect(kiosk.getByTestId('pin-status')).toContainText('Faltan dígitos: 4');
        await snap('borrar');

        // PIN inválido
        for (const d of '000000'.slice(0, 6 - 2)) await kiosk.getByRole('button', { name: d, exact: true }).click(); // ya hay 2 dígitos
        await kiosk.getByRole('button', { name: 'Confirmar' }).click();
        await expect(kiosk.getByRole('alert')).toBeVisible();
        await snap('pin-invalido');

        // verificando: la respuesta se retrasa
        let slow = true;
        await kiosk.route('**/api/kiosk/identify', async (route) => { if (slow) await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
        for (const d of '111111') await kiosk.getByRole('button', { name: d, exact: true }).click();
        await kiosk.getByRole('button', { name: 'Confirmar' }).click();
        await expect(kiosk.getByTestId('pin-status')).toContainText('Verificando');
        await snap('verificando');
        slow = false;
        await kiosk.waitForTimeout(3000);

        // error de conexión
        await context.setOffline(true);
        for (const d of '222222') await kiosk.getByRole('button', { name: d, exact: true }).click();
        await kiosk.getByRole('button', { name: 'Confirmar' }).click();
        await expect(kiosk.getByText('Sin conexión')).toBeVisible();
        await snap('sin-conexion');
        await context.setOffline(false);

        // acción exitosa: empleado real con PIN real
        const stamp = `${Date.now()}`.slice(-6);
        const emp = await page.request.post('/api/employees', { headers: H, data: { employeeNumber: `V${stamp}`, firstName: 'Visual', lastName: stamp, primaryBranchId: ven } });
        const { pin } = await emp.json();
        await kiosk.reload();
        await expect(kiosk.getByRole('heading', { name: 'Escribe tu código' })).toBeVisible();
        for (const d of pin as string) await kiosk.getByRole('button', { name: d, exact: true }).click();
        await kiosk.getByRole('button', { name: 'Confirmar' }).click();
        await expect(kiosk.getByTestId('kiosk-employee')).toBeVisible();
        await snap('acciones');
        await kiosk.getByRole('button', { name: 'Entrada', exact: true }).click();
        await expect(kiosk.getByTestId('kiosk-done')).toBeVisible();
        await snap('exito');
        await context.close();
      }
    }
    fs.writeFileSync(`${DIR}/issues-kiosco.json`, JSON.stringify(issues, null, 1));
    const n = Object.values(issues).reduce((a, l) => a + l.filter((x) => !x.startsWith('INFO')).length, 0);
    console.log(`AUDITORIA-KIOSCO problemas=${n} pantallas=${Object.keys(issues).length}`);
  });
}

import { Agent, type TestServer } from './http.js';
import { PASSWORD, type World, uniq } from './world.js';

export interface Scenario {
  fatboy: { id: string; slug: string; VEN: string; SMA: string; AME: string; adminEmail: string; encargadoRoleId: string; adminRoleId: string };
  pizza: { id: string; slug: string; CEN: string; NOR: string; adminEmail: string; encargadoRoleId: string; adminRoleId: string };
  managerVenEmail: string;
  dualEmail: string;
  employees: { ven: string; sma: string; pizza: string };
  pins: { ven: string };
  login(email: string): Promise<Agent>;
}

/**
 * Escenario realista por HTTP:
 *  - Fatboy (America/Tijuana): Venecia, San Marcos, Américas; un dueño/admin.
 *  - Pizzería X (America/Mexico_City): Centro, Norte; su admin.
 *  - Encargado de Venecia (invitado por HTTP, solo VEN).
 *  - Identidad "dual": encargado de San Marcos en Fatboy y ADMIN en Pizzería X (una sola cuenta).
 */
export async function buildScenario(world: World, server: TestServer): Promise<Scenario> {
  const fSlug = uniq('fatboy');
  const pSlug = uniq('pizza');
  const fatboyAdmin = `${fSlug}-dueno@ejemplo.com`;
  const pizzaAdmin = `${pSlug}-admin@ejemplo.com`;
  const f = await world.platformAdmin.createOrganization({
    name: 'Fatboy', slug: fSlug, timezone: 'America/Tijuana',
    branches: [{ code: 'VEN', name: 'Venecia' }, { code: 'SMA', name: 'San Marcos' }, { code: 'AME', name: 'Américas' }],
    admin: { email: fatboyAdmin, displayName: 'Dueño Fatboy', password: PASSWORD },
  });
  const p = await world.platformAdmin.createOrganization({
    name: 'Pizzería X', slug: pSlug, timezone: 'America/Mexico_City',
    branches: [{ code: 'CEN', name: 'Centro' }, { code: 'NOR', name: 'Norte' }],
    admin: { email: pizzaAdmin, displayName: 'Admin Pizza', password: PASSWORD },
  });

  const login = async (email: string) => {
    const a = new Agent(server.baseUrl);
    await a.login(email, PASSWORD);
    return a;
  };

  const fAdmin = await login(fatboyAdmin);
  const pAdmin = await login(pizzaAdmin);

  const invite = async (admin: Agent, email: string, roleId: string, scope: object) => {
    const r = await admin.post('/api/invitations', { email, roleId, scope });
    if (r.status !== 201) throw new Error(`invite: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.token as string;
  };
  const accept = async (token: string, password = PASSWORD) => {
    const r = await new Agent(server.baseUrl).post(`/api/auth/invitations/${token}/accept`, { password, displayName: 'Invitado' });
    if (r.status !== 200) throw new Error(`accept: ${r.status} ${JSON.stringify(r.body)}`);
  };

  const managerVenEmail = `${fSlug}-encargado-ven@ejemplo.com`;
  await accept(await invite(fAdmin, managerVenEmail, f.encargadoRoleId, { type: 'BRANCHES', branchIds: [f.branchIds.VEN] }));

  const dualEmail = `${uniq('dual')}@ejemplo.com`;
  await accept(await invite(fAdmin, dualEmail, f.encargadoRoleId, { type: 'BRANCHES', branchIds: [f.branchIds.SMA] }));
  await accept(await invite(pAdmin, dualEmail, p.adminRoleId, { type: 'ORGANIZATION' })); // misma identidad: verifica su contraseña actual

  const emp = async (admin: Agent, number: string, firstName: string, branchId: string) => {
    const r = await admin.post('/api/employees', { employeeNumber: number, firstName, lastName: 'Prueba', primaryBranchId: branchId });
    if (r.status !== 201) throw new Error(`employee: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as { employee: { id: string }; pin: string };
  };
  const ven = await emp(fAdmin, 'V-1', 'Juan', f.branchIds.VEN!);
  const sma = await emp(fAdmin, 'S-1', 'Pedro', f.branchIds.SMA!);
  const piz = await emp(pAdmin, 'P-1', 'Lucía', p.branchIds.CEN!);

  return {
    fatboy: { id: f.organizationId, slug: fSlug, VEN: f.branchIds.VEN!, SMA: f.branchIds.SMA!, AME: f.branchIds.AME!, adminEmail: fatboyAdmin, encargadoRoleId: f.encargadoRoleId, adminRoleId: f.adminRoleId },
    pizza: { id: p.organizationId, slug: pSlug, CEN: p.branchIds.CEN!, NOR: p.branchIds.NOR!, adminEmail: pizzaAdmin, encargadoRoleId: p.encargadoRoleId, adminRoleId: p.adminRoleId },
    managerVenEmail,
    dualEmail,
    employees: { ven: ven.employee.id, sma: sma.employee.id, pizza: piz.employee.id },
    pins: { ven: ven.pin },
    login,
  };
}

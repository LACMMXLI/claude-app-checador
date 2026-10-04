import { parseArgs } from 'node:util';
import { DomainError } from '../common/errors.js';
import { PlatformDb } from '../common/tenancy/platform-db.js';
import { PlatformAdminService } from '../modules/organizations/provisioning.service.js';
import { platformPool } from './_env.js';

const USAGE = `Uso:
  platform create-organization --name "Fatboy" --slug fatboy --timezone America/Tijuana \\
      --branch VEN="Venecia" --branch SMA="San Marcos" --branch AME="Américas" \\
      --admin-email dueno@ejemplo.com --admin-name "Nombre" --admin-password '<mínimo 10 caracteres>' \\
      [--plan BASIC|ADVANCED] [--trial-days 14]       (sin --plan: ADVANCED activo, sin vencimiento)
  platform set-status --slug fatboy --status SUSPENDED|ACTIVE
  platform reset-password --email persona@ejemplo.com --password '<nueva>'
  platform set-policy --slug fatboy --param breakRequiredAfterMin=360 --param exitToleranceMin=5
Variables: PLATFORM_DATABASE_URL (rol platform_ops).`;

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    slug: { type: 'string' },
    timezone: { type: 'string' },
    branch: { type: 'string', multiple: true },
    'admin-email': { type: 'string' },
    'admin-name': { type: 'string' },
    'admin-password': { type: 'string' },
    plan: { type: 'string' },
    'trial-days': { type: 'string' },
    status: { type: 'string' },
    email: { type: 'string' },
    password: { type: 'string' },
    param: { type: 'string', multiple: true },
  },
});

const pool = platformPool();
const admin = new PlatformAdminService(new PlatformDb(pool));
try {
  if (command === 'create-organization') {
    const result = await admin.createOrganization({
      name: values.name ?? '',
      slug: values.slug ?? '',
      timezone: values.timezone ?? '', // obligatoria: sin zona no se crea el negocio
      branches: (values.branch ?? []).map((b) => {
        const [code, ...name] = b.split('=');
        return { code: code ?? '', name: name.join('=') };
      }),
      admin: { email: values['admin-email'] ?? '', displayName: values['admin-name'] ?? '', password: values['admin-password'] },
      subscription: values.plan
        ? values['trial-days']
          ? { planCode: values.plan, status: 'TRIAL', trialEndsAt: new Date(Date.now() + Number(values['trial-days']) * 86_400_000) }
          : { planCode: values.plan, status: 'ACTIVE' }
        : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'set-status') {
    await admin.setOrganizationStatus(values.slug ?? '', values.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE');
    console.log('Estado actualizado.');
  } else if (command === 'reset-password') {
    await admin.resetPassword(values.email ?? '', values.password ?? '');
    console.log('Contraseña global restablecida.');
  } else if (command === 'set-policy') {
    const layer = Object.fromEntries(
      (values.param ?? []).map((pair) => {
        const [key, ...raw] = pair.split('=');
        const v = raw.join('=');
        return [key ?? '', v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : /^-?\d+$/.test(v) ? Number(v) : v];
      }),
    );
    await admin.setOrganizationPolicy(values.slug ?? '', layer);
    console.log('Política del negocio actualizada.');
  } else {
    console.log(USAGE);
    process.exitCode = 1;
  }
} catch (error) {
  if (error instanceof DomainError) {
    console.error(`Error: ${error.code}${Object.keys(error.details).length ? ` ${JSON.stringify(error.details)}` : ''}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await pool.end();
}

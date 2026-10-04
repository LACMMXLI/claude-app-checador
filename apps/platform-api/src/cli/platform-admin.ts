import { parseArgs } from 'node:util';
import { DomainError, createPool, requireEnv, PlatformDb } from '@checador/api/platform';
import { OperatorsService } from '../modules/operators.service.js';

const USAGE = `Uso:
  platform-admin create-operator --email ana@empresa.com --name "Ana" --password '<mínimo 10 caracteres>'
  platform-admin reset-operator-password --email ana@empresa.com --password '<nueva>'
  platform-admin list-operators
Variables: PLATFORM_DATABASE_URL (rol platform_ops).`;

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, allowPositionals: true, options: { email: { type: 'string' }, name: { type: 'string' }, password: { type: 'string' } } });

const pool = createPool(requireEnv('PLATFORM_DATABASE_URL'), 2);
const operators = new OperatorsService(new PlatformDb(pool));
try {
  if (command === 'create-operator') {
    if (!values.email || !values.name || !values.password) throw new DomainError('VALIDATION_ERROR', { fields: ['email', 'name', 'password'] });
    const { operator } = await operators.create({ email: values.email.trim().toLowerCase(), displayName: values.name, password: values.password }, 'platform-admin-cli');
    console.log(`Operador creado: ${operator.email}`);
  } else if (command === 'reset-operator-password') {
    await operators.resetPasswordByEmail(values.email ?? '', values.password ?? '');
    console.log('Contraseña restablecida; sus sesiones se cerraron.');
  } else if (command === 'list-operators') {
    for (const o of await operators.list()) console.log(`${o.status.padEnd(8)} ${o.email}  (${o.displayName})`);
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

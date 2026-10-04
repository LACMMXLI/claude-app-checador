import { afterAll, describe, expect, it } from 'vitest';
import { LOCK_MS, MAX_FAILED_ATTEMPTS, SESSION_TTL_MS } from '../src/modules/operators.service.js';
import { PASSWORD, buildWorld, makeClock, makeOperator, openPools, uniq } from './helpers/world.js';

/** D-82 · Operadores de la plataforma: sesión, bloqueo, alta, baja y contraseñas. */
const pools = openPools();
const clock = makeClock();
const world = buildWorld(pools, clock.now);
afterAll(() => pools.close());

describe('inicio de sesión', () => {
  it('credenciales correctas → sesión; el token en BD está hasheado y la sesión caduca a las 8 h', async () => {
    const op = await makeOperator(world);
    const { token, operator } = await world.operators.login(op.email, PASSWORD, { ip: '203.0.113.9', userAgent: 'vitest' });
    expect(operator.email).toBe(op.email);
    expect((await world.operators.resolve(token))?.id).toBe(op.id);
    const stored = (await pools.superuser.query('SELECT token_hash, ip FROM platform.operator_sessions WHERE operator_id = $1', [op.id])).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0].token_hash).not.toContain(token);
    expect(stored[0].ip).toBe('203.0.113.9');
    clock.advance(SESSION_TTL_MS - 1000);
    expect(await world.operators.resolve(token)).not.toBeNull();
    clock.advance(2000);
    expect(await world.operators.resolve(token)).toBeNull();
  });

  it('error genérico: contraseña mala, correo inexistente y operador deshabilitado dan el MISMO código', async () => {
    const op = await makeOperator(world);
    const code = async (email: string, pw: string) => world.operators.login(email, pw).then(() => 'OK', (e) => e.code);
    expect(await code(op.email, 'mala-mala-mala')).toBe('INVALID_CREDENTIALS');
    expect(await code('nadie@plataforma.example', PASSWORD)).toBe('INVALID_CREDENTIALS');
    const boss = await makeOperator(world);
    await world.operators.setStatus(op.id, 'DISABLED', { ...boss, status: 'ACTIVE', lastLoginAt: null, createdAt: new Date() });
    expect(await code(op.email, PASSWORD)).toBe('INVALID_CREDENTIALS');
  });

  it(`tras ${MAX_FAILED_ATTEMPTS} fallos seguidos se bloquea ${LOCK_MS / 60_000} min (aunque luego la contraseña sea la correcta) y se desbloquea solo`, async () => {
    const op = await makeOperator(world);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await expect(world.operators.login(op.email, 'incorrecta-123')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(world.operators.login(op.email, PASSWORD)).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });
    expect((await pools.superuser.query(`SELECT action FROM platform.platform_audit_log WHERE actor = $1 AND action = 'operator.locked'`, [`operator:${op.email}`])).rowCount).toBe(1);
    clock.advance(LOCK_MS + 1000);
    await expect(world.operators.login(op.email, PASSWORD)).resolves.toBeTruthy();
  });

  it('un éxito reinicia el contador de fallos', async () => {
    const op = await makeOperator(world);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) await expect(world.operators.login(op.email, 'incorrecta-123')).rejects.toBeTruthy();
    await world.operators.login(op.email, PASSWORD);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) await expect(world.operators.login(op.email, 'incorrecta-123')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(world.operators.login(op.email, PASSWORD)).resolves.toBeTruthy(); // sigue sin bloquearse
  });

  it('logout revoca la sesión; un nuevo inicio con el token previo lo revoca (rotación)', async () => {
    const op = await makeOperator(world);
    const a = await world.operators.login(op.email, PASSWORD);
    await world.operators.logout(a.token);
    expect(await world.operators.resolve(a.token)).toBeNull();
    const b = await world.operators.login(op.email, PASSWORD);
    const c = await world.operators.login(op.email, PASSWORD, { previousToken: b.token });
    expect(await world.operators.resolve(b.token)).toBeNull();
    expect(await world.operators.resolve(c.token)).not.toBeNull();
    expect(await world.operators.resolve('no-es-un-token')).toBeNull();
  });
});

describe('administración de operadores', () => {
  it('crear: sin contraseña se genera una (se devuelve una vez); duplicado y contraseña corta se rechazan; la bitácora no la guarda', async () => {
    const email = `${uniq('nuevo')}@plataforma.example`;
    const { operator, initialPassword } = await world.operators.create({ email, displayName: 'Nuevo' }, 'operator:jefe@x.com');
    expect(initialPassword).toHaveLength(16);
    await expect(world.operators.login(email, initialPassword!)).resolves.toBeTruthy();
    await expect(world.operators.create({ email, displayName: 'Otro', password: PASSWORD }, 'x')).rejects.toMatchObject({ code: 'OPERATOR_EMAIL_TAKEN' });
    await expect(world.operators.create({ email: `${uniq('c')}@x.com`, displayName: 'C', password: 'corta' }, 'x')).rejects.toMatchObject({ code: 'PASSWORD_TOO_SHORT' });
    const audit = JSON.stringify((await pools.superuser.query('SELECT details FROM platform.platform_audit_log WHERE action = $1', ['operator.created'])).rows);
    expect(audit).not.toContain(initialPassword);
    expect(operator.status).toBe('ACTIVE');
    const hash = (await pools.superuser.query('SELECT password_hash FROM platform.operators WHERE id = $1', [operator.id])).rows[0].password_hash;
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('no se puede deshabilitar a uno mismo ni al último operador activo; deshabilitar cierra sus sesiones', async () => {
    const a = await makeOperator(world);
    const b = await makeOperator(world);
    const actor = { ...a, status: 'ACTIVE' as const, lastLoginAt: null, createdAt: new Date() };
    await expect(world.operators.setStatus(a.id, 'DISABLED', actor)).rejects.toMatchObject({ code: 'CANNOT_DISABLE_SELF' });
    const session = await world.operators.login(b.email, PASSWORD);
    await world.operators.setStatus(b.id, 'DISABLED', actor);
    expect(await world.operators.resolve(session.token)).toBeNull();
    // reactivar devuelve el acceso
    await world.operators.setStatus(b.id, 'ACTIVE', actor);
    await expect(world.operators.login(b.email, PASSWORD)).resolves.toBeTruthy();
    // el último activo: dejar solo a `a` y probar con un tercero que intente deshabilitarla
    await pools.superuser.query(`UPDATE platform.operators SET status = 'DISABLED' WHERE id <> $1`, [a.id]);
    const ghost = { ...b, status: 'ACTIVE' as const, lastLoginAt: null, createdAt: new Date() };
    await expect(world.operators.setStatus(a.id, 'DISABLED', ghost)).rejects.toMatchObject({ code: 'LAST_OPERATOR' });
    await pools.superuser.query(`UPDATE platform.operators SET status = 'ACTIVE'`);
  });

  it('restablecer contraseña de otro operador: nueva contraseña generada, desbloqueo y sesiones cerradas', async () => {
    const admin = await makeOperator(world);
    const target = await makeOperator(world);
    const s = await world.operators.login(target.email, PASSWORD);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await world.operators.login(target.email, 'incorrecta-123').catch(() => undefined);
    const { password } = await world.operators.resetPassword(target.id, { ...admin, status: 'ACTIVE', lastLoginAt: null, createdAt: new Date() });
    expect(await world.operators.resolve(s.token)).toBeNull();
    await expect(world.operators.login(target.email, PASSWORD)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(world.operators.login(target.email, password)).resolves.toBeTruthy();
    expect(JSON.stringify((await pools.superuser.query(`SELECT details FROM platform.platform_audit_log WHERE action = 'operator.password_reset'`)).rows)).not.toContain(password);
  });

  it('cambiar la PROPIA contraseña exige la actual, conserva esta sesión y cierra las demás', async () => {
    const op = await makeOperator(world);
    const mine = await world.operators.login(op.email, PASSWORD);
    const other = await world.operators.login(op.email, PASSWORD);
    await expect(world.operators.changeOwnPassword(op.id, 'no-es-la-actual', 'otra-clave-larga-1', mine.token)).rejects.toMatchObject({ code: 'CURRENT_PASSWORD_INVALID' });
    await expect(world.operators.changeOwnPassword(op.id, PASSWORD, PASSWORD, mine.token)).rejects.toMatchObject({ code: 'NEW_PASSWORD_SAME_AS_CURRENT' });
    await world.operators.changeOwnPassword(op.id, PASSWORD, 'otra-clave-larga-1', mine.token);
    expect(await world.operators.resolve(mine.token)).not.toBeNull();
    expect(await world.operators.resolve(other.token)).toBeNull();
    await expect(world.operators.login(op.email, 'otra-clave-larga-1')).resolves.toBeTruthy();
  });
});

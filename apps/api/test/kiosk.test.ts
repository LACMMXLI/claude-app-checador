import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockoutRemainingSec } from '../src/modules/auth/pin-attempts.service.js';
import { parseKioskToken } from '../src/modules/auth/kiosk-devices.service.js';
import { buildWorld, openPools, seedOrganization, type SeededOrg } from './helpers/world.js';

describe('bloqueo por intentos de PIN (puro)', () => {
  const policy = { pinMaxAttempts: 5, pinLockoutSec: 60 };
  const t0 = new Date('2030-01-01T10:00:00Z');
  const at = (sec: number) => new Date(t0.getTime() + sec * 1000);
  it('no bloquea antes del umbral; bloquea al llegar a N fallos y retrocede exponencialmente (tope 1 h)', () => {
    expect(lockoutRemainingSec(4, t0, policy, t0)).toBe(0);
    expect(lockoutRemainingSec(5, t0, policy, at(10))).toBe(50);
    expect(lockoutRemainingSec(5, t0, policy, at(61))).toBe(0);
    expect(lockoutRemainingSec(7, t0, policy, t0)).toBe(0);      // entre múltiplos se permiten intentos
    expect(lockoutRemainingSec(10, t0, policy, t0)).toBe(120);   // segundo bloqueo: el doble
    expect(lockoutRemainingSec(15, t0, policy, t0)).toBe(240);
    expect(lockoutRemainingSec(500, t0, policy, t0)).toBe(3600); // tope
    expect(lockoutRemainingSec(0, null, policy, t0)).toBe(0);
  });
});

const pools = openPools();
let clockNow = new Date('2030-05-01T12:00:00Z');
const world = buildWorld(pools, { clock: () => clockNow });
let A: SeededOrg;
let B: SeededOrg;

beforeAll(async () => {
  A = await seedOrganization(world);
  B = await seedOrganization(world);
});
afterAll(() => pools.close());

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const kioskCtx = (org: SeededOrg, deviceId = org.deviceId) => world.kiosks.contextFor({ deviceId, organizationId: org.organizationId, branchId: org.branchA });

describe('emparejamiento y token de kiosco', () => {
  it('el código es de un solo uso, se guarda hasheado y el token queda ligado a negocio + sucursal + dispositivo', async () => {
    const { code } = await world.kiosks.createPairingCode(A.adminCtx, A.branchA);
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    const stored = (await pools.platform.query(`SELECT code_hash FROM core.kiosk_pairing_codes WHERE code_hash = $1`, [sha256(code)])).rowCount;
    expect(stored).toBe(1);
    expect((await pools.platform.query(`SELECT 1 FROM core.kiosk_pairing_codes WHERE code_hash = $1`, [code])).rowCount).toBe(0);

    const kiosk = await world.kiosks.redeem(code, 'Tablet barra');
    expect(parseKioskToken(kiosk.token)).not.toBeNull();
    expect(kiosk).toMatchObject({ organizationId: A.organizationId, branchId: A.branchA });
    await expect(world.kiosks.redeem(code, 'Otra tablet')).rejects.toMatchObject({ code: 'PAIRING_CODE_INVALID' }); // ya usado
    await expect(world.kiosks.redeem('ZZZZZZZZ', 'x')).rejects.toMatchObject({ code: 'PAIRING_CODE_INVALID' });

    // En la BD solo hay el hash del secreto, jamás el token
    const device = (await pools.platform.query(`SELECT * FROM core.kiosk_devices WHERE id = $1`, [kiosk.deviceId])).rows[0];
    const [, secret] = kiosk.token.split('.');
    expect(device.token_hash).toBe(sha256(secret!));
    expect(JSON.stringify(device)).not.toContain(secret);
    expect(device).toMatchObject({ organization_id: A.organizationId, branch_id: A.branchA, status: 'ACTIVE' });
  });

  it('un código vencido no se puede canjear', async () => {
    const { code } = await world.kiosks.createPairingCode(A.adminCtx, A.branchA, -1);
    await expect(world.kiosks.redeem(code, 'Tarde')).rejects.toMatchObject({ code: 'PAIRING_CODE_INVALID' });
  });

  it('el token autentica y entrega SOLO la identidad de su negocio y sucursal', async () => {
    const id = await world.kiosks.authenticate(A.kioskToken);
    expect(id).toEqual({ deviceId: A.deviceId, organizationId: A.organizationId, branchId: A.branchA });
    const ctx = world.kiosks.contextFor(id);
    expect(ctx).toMatchObject({ organizationId: A.organizationId, actor: { type: 'KIOSK', deviceId: A.deviceId } });
    expect((await world.kiosks.authenticate(B.kioskToken)).organizationId).toBe(B.organizationId);
  });

  it('rechaza tokens malformados, con secreto alterado, o con el prefijo de otro dispositivo', async () => {
    const [prefix, secret] = A.kioskToken.split('.');
    for (const bad of ['', 'basura', `${A.kioskToken}x`, `${A.kioskToken.slice(0, -1)}`, `${prefix}.${'A'.repeat(43)}`, `kt_${'a'.repeat(12)}.${secret}`]) {
      await expect(world.kiosks.authenticate(bad), bad).rejects.toMatchObject({ code: 'KIOSK_TOKEN_INVALID' });
    }
    const [, bSecret] = B.kioskToken.split('.');
    await expect(world.kiosks.authenticate(`${prefix}.${bSecret}`)).rejects.toMatchObject({ code: 'KIOSK_TOKEN_INVALID' }); // prefijo de A + secreto de B
  });

  it('un token revocado deja de funcionar; un negocio suspendido tampoco; y todo queda auditado', async () => {
    const { code } = await world.kiosks.createPairingCode(A.adminCtx, A.branchB);
    const k = await world.kiosks.redeem(code, 'Tablet temporal');
    await world.kiosks.authenticate(k.token);
    await world.kiosks.revoke(A.adminCtx, k.deviceId, 'Se perdió la tablet');
    await expect(world.kiosks.authenticate(k.token)).rejects.toMatchObject({ code: 'KIOSK_TOKEN_INVALID' });
    const audit = (await pools.platform.query(`SELECT action, reason FROM audit.audit_log WHERE entity_id = $1 ORDER BY id`, [k.deviceId])).rows.map((r) => r.action);
    expect(audit).toEqual(['kiosk.paired', 'kiosk.revoked']);

    await world.platformAdmin.setOrganizationStatus(A.slug, 'SUSPENDED');
    await expect(world.kiosks.authenticate(A.kioskToken)).rejects.toMatchObject({ code: 'KIOSK_TOKEN_INVALID' });
    await world.platformAdmin.setOrganizationStatus(A.slug, 'ACTIVE');
    await expect(world.kiosks.authenticate(A.kioskToken)).resolves.toBeTruthy();
  });

  it('el kiosco de un negocio solo identifica a SUS empleados', async () => {
    await expect(world.kioskIdentification.identify(kioskCtx(B), B.branchA, A.employeePin)).rejects.toMatchObject({ code: 'INVALID_PIN' }); // PIN de A en el kiosco de B (otro hash)
    expect((await world.kioskIdentification.identify(kioskCtx(A), A.branchA, A.employeePin)).id).toBe(A.employeeId);
  });

  it('solo un contexto de kiosco puede identificar', async () => {
    await expect(world.kioskIdentification.identify(A.adminCtx, A.branchA, A.employeePin)).rejects.toMatchObject({ code: 'KIOSK_CONTEXT_REQUIRED' });
  });
});

describe('protección contra intentos masivos de PIN', () => {
  const fail = (org: SeededOrg, deviceId?: string) => world.kioskIdentification.identify(kioskCtx(org, deviceId), org.branchA, '000001').catch((e) => e);

  it('5 fallos ⇒ bloqueo (incluso con el PIN correcto); se libera al pasar el tiempo; un acierto reinicia; el bloqueo escala', async () => {
    const code = await world.kiosks.createPairingCode(A.adminCtx, A.branchA);
    const dev = await world.kiosks.redeem(code.code, 'Tablet de pruebas de bloqueo');
    const ctx = kioskCtx(A, dev.deviceId);
    clockNow = new Date('2030-06-01T12:00:00Z');

    for (let i = 0; i < 5; i += 1) expect((await fail(A, dev.deviceId)).code).toBe('INVALID_PIN');
    const locked = await world.kioskIdentification.identify(ctx, A.branchA, A.employeePin).catch((e) => e);
    expect(locked).toMatchObject({ code: 'PIN_LOCKED' });
    expect(locked.details.retryAfterSec).toBe(60);

    clockNow = new Date(clockNow.getTime() + 30_000);
    expect(((await fail(A, dev.deviceId)) as { details: { retryAfterSec: number } }).details.retryAfterSec).toBe(30);

    clockNow = new Date(clockNow.getTime() + 31_000); // pasó el minuto
    expect((await world.kioskIdentification.identify(ctx, A.branchA, A.employeePin)).id).toBe(A.employeeId); // acierto: reinicia

    for (let i = 0; i < 5; i += 1) await fail(A, dev.deviceId); // 5 nuevos fallos ⇒ vuelve a 60 s (reinició)
    expect(((await fail(A, dev.deviceId)) as { details: { retryAfterSec: number } }).details.retryAfterSec).toBe(60);
    clockNow = new Date(clockNow.getTime() + 61_000);
    for (let i = 0; i < 5; i += 1) await fail(A, dev.deviceId); // sigue sin acertar: 10 fallos consecutivos ⇒ 120 s
    expect(((await fail(A, dev.deviceId)) as { details: { retryAfterSec: number } }).details.retryAfterSec).toBe(120);
  });

  it('el bloqueo es por kiosco: otro dispositivo (del mismo negocio) sigue operando', async () => {
    const dev1 = await world.kiosks.redeem((await world.kiosks.createPairingCode(A.adminCtx, A.branchA)).code, 'K1');
    const dev2 = await world.kiosks.redeem((await world.kiosks.createPairingCode(A.adminCtx, A.branchA)).code, 'K2');
    for (let i = 0; i < 5; i += 1) await fail(A, dev1.deviceId);
    await expect(world.kioskIdentification.identify(kioskCtx(A, dev1.deviceId), A.branchA, A.employeePin)).rejects.toMatchObject({ code: 'PIN_LOCKED' });
    await expect(world.kioskIdentification.identify(kioskCtx(A, dev2.deviceId), A.branchA, A.employeePin)).resolves.toMatchObject({ id: A.employeeId });
  });

  it('los umbrales salen de la política jerárquica (configurable por negocio/sucursal)', async () => {
    await world.policies.setOverride(B.adminCtx, 'BRANCH', B.branchA, { pinMaxAttempts: 2, pinLockoutSec: 300 });
    const dev = await world.kiosks.redeem((await world.kiosks.createPairingCode(B.adminCtx, B.branchA)).code, 'KB');
    clockNow = new Date('2030-07-01T00:00:00Z');
    await fail(B, dev.deviceId);
    await fail(B, dev.deviceId);
    const err = await world.kioskIdentification.identify(kioskCtx(B, dev.deviceId), B.branchA, B.employeePin).catch((e) => e);
    expect(err).toMatchObject({ code: 'PIN_LOCKED', details: { retryAfterSec: 300 } });
  });

  it('todo intento queda registrado SIN guardar el PIN intentado; el error no revela si el PIN existe', async () => {
    const attempts = (await pools.platform.query(`SELECT * FROM core.pin_attempts WHERE organization_id = $1`, [A.organizationId])).rows;
    expect(attempts.length).toBeGreaterThan(5);
    expect(attempts.some((a) => a.success)).toBe(true);
    expect(attempts.some((a) => !a.success && a.employee_id === null)).toBe(true);
    expect(Object.keys(attempts[0])).not.toContain('pin');
    const unknown = await world.kioskIdentification.identify(kioskCtx(A), A.branchA, '135790').catch((e) => e);
    const malformed = await world.kioskIdentification.identify(kioskCtx(A), A.branchA, 'abc').catch((e) => e);
    expect(unknown.code).toBe('INVALID_PIN');
    expect(malformed.code).toBe('INVALID_PIN');
    expect(unknown.details).toEqual(malformed.details);
  });
});

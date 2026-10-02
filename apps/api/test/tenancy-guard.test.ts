import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { URLS } from './helpers/config.js';
import { openPools } from './helpers/world.js';

const pools = openPools();
afterAll(() => pools.close());
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const violations = async () =>
  (await pools.migrator.query<{ table_name: string; problem: string }>('SELECT table_name, problem FROM core.tenant_isolation_violations()')).rows;

/** Ejecuta exactamente el mismo comando que corre CI (`pnpm check:tenancy`). */
function runCiCheck() {
  return spawnSync('npx', ['tsx', 'src/cli/check-tenancy.ts'], {
    cwd: apiDir,
    env: { ...process.env, MIGRATOR_DATABASE_URL: URLS.migrator },
    encoding: 'utf8',
  });
}

const created: string[] = [];
async function ddl(sql: string, dropTarget?: string) {
  await pools.migrator.query(sql);
  if (dropTarget) created.push(dropTarget);
}
afterEach(async () => {
  for (const target of created.splice(0)) await pools.migrator.query(`DROP ${target} CASCADE`);
});

describe('verificación de aislamiento multi-tenant (lo que ejecuta CI)', () => {
  it('el esquema migrado está limpio y el comando de CI termina con código 0', async () => {
    expect(await violations()).toEqual([]);
    const result = runCiCheck();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('verificado');
  });

  it('una tabla multi-tenant NUEVA sin protección hace fallar CI (código 1) y nombra el problema', async () => {
    await ddl(`CREATE TABLE core.tabla_nueva_sin_proteccion (id uuid PRIMARY KEY, organization_id uuid NOT NULL, dato text)`, 'TABLE core.tabla_nueva_sin_proteccion');
    const found = (await violations()).filter((v) => v.table_name === 'core.tabla_nueva_sin_proteccion').map((v) => v.problem);
    expect(found).toEqual(expect.arrayContaining([expect.stringMatching(/RLS no habilitado/), expect.stringMatching(/no forzado/), expect.stringMatching(/sin política/)]));

    const result = runCiCheck();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('core.tabla_nueva_sin_proteccion');

    // …y vuelve a pasar cuando se protege con el helper oficial
    await pools.migrator.query(`SELECT core.enable_tenant_rls('core.tabla_nueva_sin_proteccion')`);
    expect(await violations()).toEqual([]);
    expect(runCiCheck().status).toBe(0);
  });

  it('una tabla de negocio SIN organization_id (y no registrada como excepción) falla CI', async () => {
    await ddl(`CREATE TABLE core.sin_tenant (id uuid PRIMARY KEY, dato text)`, 'TABLE core.sin_tenant');
    expect((await violations()).map((v) => v.table_name)).toContain('core.sin_tenant');
    expect(runCiCheck().status).toBe(1);
  });

  it('también se detecta en un esquema de módulo futuro (p. ej. attendance)', async () => {
    await ddl(`CREATE SCHEMA modulo_futuro`, 'SCHEMA modulo_futuro');
    await ddl(`CREATE TABLE modulo_futuro.cosas (id uuid PRIMARY KEY, organization_id uuid NOT NULL)`);
    expect((await violations()).map((v) => v.table_name)).toContain('modulo_futuro.cosas');
  });

  it('detecta organization_id que admite NULL', async () => {
    await ddl(`CREATE TABLE core.nullable_org (id uuid PRIMARY KEY, organization_id uuid)`, 'TABLE core.nullable_org');
    await pools.migrator.query(`SELECT core.enable_tenant_rls('core.nullable_org')`);
    expect((await violations()).filter((v) => v.table_name === 'core.nullable_org').map((v) => v.problem)).toEqual([expect.stringMatching(/admite NULL/)]);
  });

  it('detecta una política débil (USING true) aunque el RLS esté habilitado y forzado', async () => {
    await ddl(`CREATE TABLE core.politica_debil (id uuid PRIMARY KEY, organization_id uuid NOT NULL)`, 'TABLE core.politica_debil');
    await pools.migrator.query(`ALTER TABLE core.politica_debil ENABLE ROW LEVEL SECURITY; ALTER TABLE core.politica_debil FORCE ROW LEVEL SECURITY;
                                CREATE POLICY todo ON core.politica_debil USING (true) WITH CHECK (true)`);
    expect((await violations()).filter((v) => v.table_name === 'core.politica_debil').map((v) => v.problem)).toEqual([expect.stringMatching(/sin política/)]);
  });

  it('detecta RLS habilitado pero no forzado (el dueño de la tabla lo evitaría)', async () => {
    await ddl(`CREATE TABLE core.sin_force (id uuid PRIMARY KEY, organization_id uuid NOT NULL)`, 'TABLE core.sin_force');
    await pools.migrator.query(`SELECT core.enable_tenant_rls('core.sin_force'); ALTER TABLE core.sin_force NO FORCE ROW LEVEL SECURITY`);
    expect((await violations()).filter((v) => v.table_name === 'core.sin_force').map((v) => v.problem)).toEqual([expect.stringMatching(/no forzado/)]);
  });

  it('detecta columnas timestamp sin zona horaria (todo debe ser timestamptz/UTC)', async () => {
    await ddl(`CREATE TABLE core.hora_ingenua (id uuid PRIMARY KEY, organization_id uuid NOT NULL, cuando timestamp)`, 'TABLE core.hora_ingenua');
    await pools.migrator.query(`SELECT core.enable_tenant_rls('core.hora_ingenua')`);
    expect((await violations()).map((v) => v.problem)).toEqual([expect.stringMatching(/WITHOUT time zone/)]);
  });
});

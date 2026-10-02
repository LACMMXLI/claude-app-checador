import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
const rel = (p: string) => path.relative(src, p).replaceAll('\\', '/');
/** Código sin comentarios (los comentarios pueden mencionar lo prohibido para explicarlo). */
const read = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** Imports en tiempo de ejecución (excluye `import type`). */
const runtimeImports = (p: string) => [...read(p).matchAll(/^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!);

describe('reglas de arquitectura (impuestas en CI)', () => {
  const all = files(src);

  it('los módulos de negocio NUNCA importan (en ejecución) el pool crudo, `pg`, el acceso de plataforma ni el driver de Drizzle: solo TenantDb', () => {
    const forbidden = /^(pg|drizzle-orm\/node-postgres|(\.\.?\/)+db\/pool\.js|(\.\.?\/)+common\/tenancy\/platform-db\.js)$/;
    const offenders = all.filter((f) => rel(f).startsWith('modules/') && runtimeImports(f).some((i) => forbidden.test(i)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('PlatformDb (BYPASSRLS) solo se usa en el CLI de plataforma y en su servicio; la raíz de composición de la API no lo conoce', () => {
    const users = all.filter((f) => /PlatformDb/.test(read(f))).map(rel).sort();
    expect(users).toEqual(['cli/platform.ts', 'common/tenancy/platform-db.ts', 'modules/organizations/provisioning.service.ts']);
    expect(read(path.join(src, 'container.ts'))).not.toMatch(/PlatformDb|platform_ops|PLATFORM_DATABASE_URL/);
  });

  it('solo `db/pool.ts` crea pools (new Pool) y solo `common/tenancy` y `db` tocan conexiones', () => {
    const creators = all.filter((f) => /new (pg\.)?Pool\(|new pg\.Client\(|new Client\(/.test(read(f))).map(rel).sort();
    expect(creators).toEqual(['cli/check-tenancy.ts', 'db/bootstrap.ts', 'db/migrate.ts', 'db/pool.ts']);
  });

  it('el HTTP/Nest no usa SQL crudo ni conoce las tablas: solo servicios', () => {
    const http = all.filter((f) => rel(f).startsWith('http/') || /\.controller\.ts$/.test(f));
    for (const f of http) expect(read(f), rel(f)).not.toMatch(/db\/schema|drizzle-orm|from 'pg'/);
  });

  it('ningún servicio de negocio lee organizationId de datos del cliente: siempre del TenantContext', () => {
    for (const f of all.filter((x) => rel(x).startsWith('modules/') && x.endsWith('.service.ts'))) {
      expect(read(f), rel(f)).not.toMatch(/input\.organizationId|body\.organizationId|params\.organizationId|query\.organizationId/);
    }
  });
});

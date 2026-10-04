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
const read = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const all = files(src);

describe('reglas de arquitectura de la plataforma (D-81)', () => {
  it('los controladores HTTP no conocen SQL, tablas ni Drizzle: solo servicios', () => {
    for (const f of all.filter((x) => rel(x).startsWith('http/'))) expect(read(f), rel(f)).not.toMatch(/drizzle-orm|from 'pg'|\{[^}]*\bschema\b[^}]*\}\s*from|\.execute\(/);
  });

  it('solo main.ts y la CLI crean el pool; nadie más abre conexiones', () => {
    const creators = all.filter((f) => /createPool\(|new (pg\.)?Pool\(/.test(read(f))).map(rel).sort();
    expect(creators).toEqual(['cli/platform-admin.ts', 'main.ts']);
  });

  it('el servicio de plataforma solo importa de la API de clientes su punto de entrada público (@checador/api/platform)', () => {
    for (const f of all) {
      const imports = [...read(f).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const i of imports.filter((x) => x.includes('checador/api') || x.includes('../api'))) expect(i, rel(f)).toBe('@checador/api/platform');
    }
  });

  it('ningún servicio, log ni respuesta escribe contraseñas: las contraseñas generadas solo se devuelven al llamador', () => {
    for (const f of all) expect(read(f), rel(f)).not.toMatch(/console\.(log|info|warn|error)\([^)]*(password|passwordHash|initialPassword)/i);
  });
});

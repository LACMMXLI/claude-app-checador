import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { createPlatformApp } from '../../src/app.module.js';
import type { Container } from '../../src/container.js';
import type { HttpConfig } from '../../src/http/tokens.js';
import type { Pools } from './world.js';

export interface TestServer { app: INestApplication; baseUrl: string; close(): Promise<void> }

export async function startServer(pools: Pools, container: Container, secureCookies = false, http: Partial<HttpConfig> = {}): Promise<TestServer> {
  const app = await createPlatformApp({ pool: pools.platform, container, http: { secureCookies, ...http } }, false);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${port}`, close: () => app.close() };
}

export interface Res<T = any> { status: number; body: T; headers: Headers }

/** Cliente HTTP con "frasco" de cookies (como el navegador de un operador). */
export class Agent {
  cookies = new Map<string, string>();
  constructor(private readonly baseUrl: string, private readonly csrf: string | null = 'platform') {}

  get sid(): string | undefined {
    return this.cookies.get('psid') ?? this.cookies.get('__Host-psid');
  }

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const h: Record<string, string> = { ...headers };
    if (method !== 'GET' && this.csrf && !('x-requested-with' in h)) h['x-requested-with'] = this.csrf;
    if (body !== undefined) h['content-type'] = 'application/json';
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, ...value] = pair!.split('=');
      const v = value.join('=');
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), v);
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }
  get<T = any>(path: string) { return this.request<T>('GET', path); }
  post<T = any>(path: string, body: unknown = {}) { return this.request<T>('POST', path, body); }
  patch<T = any>(path: string, body: unknown = {}) { return this.request<T>('PATCH', path, body); }

  async login(email: string, password: string) {
    const r = await this.post('/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
    return r;
  }
}

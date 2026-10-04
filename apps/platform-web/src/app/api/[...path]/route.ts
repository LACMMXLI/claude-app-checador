/**
 * Proxy same-origin hacia la API de plataforma. Así la cookie de sesión del operador es de primera parte (HttpOnly,
 * SameSite=Strict) y el navegador nunca guarda tokens en localStorage. La URL interna se lee en TIEMPO DE EJECUCIÓN.
 */
const API = () => process.env.PLATFORM_API_INTERNAL_URL ?? 'http://127.0.0.1:3100';
const FORWARD_REQUEST = ['cookie', 'content-type', 'x-requested-with', 'user-agent', 'x-request-id'];

async function proxy(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const target = `${API()}/api/${path.map(encodeURIComponent).join('/')}${url.search}`;
  const headers = new Headers();
  for (const h of FORWARD_REQUEST) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  // Se reenvía la cadena X-Forwarded-For tal cual (la API decide cuánto creer: TRUSTED_PROXIES); solo informativa.
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) headers.set('x-forwarded-for', fwd);
  let res: Response;
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
      redirect: 'manual',
      signal: req.signal,
    });
  } catch {
    return Response.json({ error: { code: 'API_UNAVAILABLE', details: {} } }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
  const out = new Headers();
  const type = res.headers.get('content-type');
  if (type) out.set('content-type', type);
  for (const c of res.headers.getSetCookie()) out.append('set-cookie', c);
  out.set('cache-control', 'no-store');
  return new Response(res.status === 204 ? null : await res.arrayBuffer(), { status: res.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const dynamic = 'force-dynamic';

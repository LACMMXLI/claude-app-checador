/**
 * Proxy same-origin hacia la API (NestJS). Así la cookie de sesión es de primera parte (HttpOnly,
 * SameSite) y el navegador nunca guarda tokens en localStorage. La URL interna se lee en TIEMPO DE
 * EJECUCIÓN (API_INTERNAL_URL), no en el build.
 */
const API = () => process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3000';
const FORWARD_REQUEST = ['cookie', 'content-type', 'x-requested-with', 'authorization', 'user-agent', 'x-request-id'];

async function proxy(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const target = `${API()}/api/${path.map(encodeURIComponent).join('/')}${url.search}`;
  const headers = new Headers();
  for (const h of FORWARD_REQUEST) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  // D-79: se reenvía la cadena X-Forwarded-For tal cual. Delante está Traefik (que pone la IP del cliente); si no viene
  // ninguna, Next.js la completa con el par TCP. La API decide cuánto de ella creer (TRUSTED_PROXIES/TRUSTED_PROXY_HOPS);
  // X-Real-IP y Forwarded no se reenvían a propósito.
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) headers.set('x-forwarded-for', fwd);
  let res: Response;
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
      redirect: 'manual',
      signal: req.signal, // si el navegador se desconecta (p. ej. SSE), se corta también hacia la API
    });
  } catch {
    return Response.json({ error: { code: 'API_UNAVAILABLE', details: {} } }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
  const out = new Headers();
  const type = res.headers.get('content-type');
  if (type) out.set('content-type', type);
  for (const c of res.headers.getSetCookie()) out.append('set-cookie', c);
  out.set('cache-control', 'no-store');
  // SSE (D-75): se reenvía en STREAMING, sin acumular la respuesta (y se pide lo mismo a cualquier proxy delante)
  if (type?.startsWith('text/event-stream')) {
    out.set('cache-control', 'no-cache, no-transform');
    out.set('x-accel-buffering', 'no');
    return new Response(res.body, { status: res.status, headers: out });
  }
  // descargas de reportes (D-74): conservar el nombre del archivo
  const disposition = res.headers.get('content-disposition');
  if (disposition) out.set('content-disposition', disposition);
  return new Response(res.status === 204 ? null : await res.arrayBuffer(), { status: res.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const dynamic = 'force-dynamic';

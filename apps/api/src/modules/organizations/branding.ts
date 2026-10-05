import { z } from 'zod';

/** Imágenes de marca de un negocio: una ruta del propio sitio (`/brand/…`) o una URL https. Nunca `javascript:`, `data:` ni http. */
const assetUrl = z
  .string()
  .max(500)
  .regex(/^(\/brand\/[A-Za-z0-9._\/-]+|https:\/\/[^\s"'<>]+)$/)
  .refine((v) => !v.includes('..'), 'sin ..');

export const brandingSchema = z.object({ logoUrl: assetUrl.optional(), artUrl: assetUrl.optional() });
export type Branding = z.infer<typeof brandingSchema>;

/** Lo que sale hacia el panel: solo claves conocidas y valores seguros (lo demás en la columna se ignora). */
export function publicBranding(raw: unknown): Branding {
  const out: Branding = {};
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  for (const key of ['logoUrl', 'artUrl'] as const) {
    const parsed = assetUrl.safeParse(src[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

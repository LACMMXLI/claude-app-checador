import type { z } from 'zod';
import { DomainError } from '@checador/api/platform';

/** Valida y LIMPIA la entrada: los campos no declarados se descartan. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw new DomainError('VALIDATION_ERROR', { fields: result.error.issues.map((i) => i.path.join('.') || '(raíz)') });
  return result.data;
}

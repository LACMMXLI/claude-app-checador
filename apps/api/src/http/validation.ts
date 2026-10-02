import type { z } from 'zod';
import { DomainError } from '../common/errors.js';

/** Valida y LIMPIA la entrada: los campos no declarados (p. ej. `organizationId`) se descartan. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new DomainError('VALIDATION_ERROR', { fields: result.error.issues.map((i) => i.path.join('.') || '(raíz)') });
  }
  return result.data;
}

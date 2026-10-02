/**
 * Error de dominio con un `code` estable. La API devuelve códigos (no textos) y el cliente los
 * traduce con el sistema de i18n (RN-I18N-01). No incluir datos sensibles en `details`.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'DomainError';
  }
}

/** ¿Es un error de PostgreSQL con este SQLSTATE (y, opcionalmente, esta restricción)? */
export function isPgError(error: unknown, code: string, constraint?: string): boolean {
  let current: unknown = error;
  // Drizzle envuelve el error original en `cause`
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const e = current as { code?: string; constraint?: string; cause?: unknown };
    if (e.code === code && (constraint === undefined || e.constraint === constraint)) return true;
    current = e.cause;
  }
  return false;
}

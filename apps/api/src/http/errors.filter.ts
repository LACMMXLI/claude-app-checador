import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError, isPgError, raisedCode } from '../common/errors.js';

const STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  KIOSK_TOKEN_INVALID: 401,
  ACCOUNT_LOCKED: 423,
  FORBIDDEN: 403,
  CSRF_CHECK_FAILED: 403,
  MEMBERSHIP_NOT_AVAILABLE: 403,
  NO_ACTIVE_ORGANIZATION: 409,
  INVITATION_INVALID: 410,
  PIN_PAUSED: 429,
  INVALID_PIN: 401,
  SHIFT_HISTORY_LOCKED: 403,
  SELF_CORRECTION_FORBIDDEN: 403,
  SELF_APPROVAL_FORBIDDEN: 403,
  NO_EMPLOYEE_RECORD: 403,
  TOO_MANY_PENDING_REQUESTS: 409,
  EXPORT_RATE_LIMITED: 429,
  SSE_TOO_MANY_CONNECTIONS: 429,
  PUNCH_TOO_SOON: 429,
  KIOSK_TICKET_INVALID: 401,
  KIOSK_NOT_ACTIVATED: 401,
};
const CONFLICTS = /(_TAKEN|ALREADY_MEMBER|LAST_ADMIN|_OVERLAP|ALREADY_ACTIVE|_VERSION_CONFLICT|ALREADY_PUBLISHED|_NOT_DRAFT|_CANCELLED|USE_CANCEL|_DUPLICATE_ENTRY|_NOT_PUBLISHED|_HAS_ATTENDANCE|_NOT_OFFICIAL|_ALREADY_CLOSED|BREAK_OPEN|_ALREADY_OPEN|NO_OPEN_|_NOT_ALLOWED_NOW|IDEMPOTENCY_KEY_REUSED|_ALREADY_RESOLVED|MAX_BREAKS_REACHED|_IN_REVIEW|_ALREADY_DECIDED|_ALREADY_PENDING|BREAK_OVERLAP|FALTA_NOT_APPLICABLE|_HAS_SESSION)$/;

/**
 * Respuesta uniforme `{ error: { code, details } }` con códigos estables (el cliente los traduce).
 * Nunca se devuelven mensajes internos de PostgreSQL. Los rechazos de RLS (42501) se tratan como 403.
 */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const raised = raisedCode(exception);
    if (raised) exception = new DomainError(raised); // invariante de PostgreSQL ⇒ mismo trato que un error de dominio
    if (exception instanceof DomainError) {
      const status = STATUS[exception.code] ?? (exception.code.endsWith('_NOT_FOUND') ? 404 : CONFLICTS.test(exception.code) ? 409 : 400);
      res.status(status).json({ error: { code: exception.code, details: exception.details } });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json({ error: { code: status === 404 ? 'ROUTE_NOT_FOUND' : status === 400 ? 'VALIDATION_ERROR' : 'HTTP_ERROR', details: {} } });
      return;
    }
    if (isPgError(exception, '42501')) return void res.status(403).json({ error: { code: 'FORBIDDEN', details: {} } });
    if (isPgError(exception, '23503')) return void res.status(400).json({ error: { code: 'INVALID_REFERENCE', details: {} } });
    if (isPgError(exception, '23505')) return void res.status(409).json({ error: { code: 'DUPLICATE', details: {} } });
    if (isPgError(exception, '23514') || isPgError(exception, '22023') || isPgError(exception, '22P02')) {
      return void res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: {} } });
    }
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', details: {} } });
  }
}

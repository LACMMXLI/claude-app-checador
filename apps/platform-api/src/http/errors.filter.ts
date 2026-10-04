import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError, isPgError, raisedCode } from '@checador/api/platform';

const STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 423,
  FORBIDDEN: 403,
  CSRF_CHECK_FAILED: 403,
  CURRENT_PASSWORD_INVALID: 403,
  PLAN_LIMIT_BRANCHES: 422,
};
const CONFLICTS = /(_TAKEN|_NOT_ACTIVE|_STATE_INVALID|_UNCHANGED|LAST_|CANNOT_DISABLE_SELF|ALREADY_)/;

/** Respuesta uniforme `{ error: { code, details } }` con códigos estables; nunca mensajes internos de PostgreSQL. */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const raised = raisedCode(exception);
    if (raised) exception = new DomainError(raised);
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
    if (isPgError(exception, '23505')) return void res.status(409).json({ error: { code: 'DUPLICATE', details: {} } });
    if (isPgError(exception, '23503')) return void res.status(400).json({ error: { code: 'INVALID_REFERENCE', details: {} } });
    if (isPgError(exception, '23514') || isPgError(exception, '22023') || isPgError(exception, '22P02')) {
      return void res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: {} } });
    }
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', details: {} } });
  }
}

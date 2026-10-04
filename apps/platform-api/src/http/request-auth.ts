import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DomainError } from '@checador/api/platform';
import type { Container } from '../container.js';
import { type OperatorView, actorLabel } from '../modules/operators.service.js';
import { CONTAINER, HTTP_CONFIG, type HttpConfig, sessionCookieName } from './tokens.js';

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Autenticación por petición: la sesión del operador se resuelve en CADA llamada (nada se cachea). */
@Injectable()
export class RequestAuth {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(HTTP_CONFIG) private readonly cfg: HttpConfig,
  ) {}

  token(req: Request): string | null {
    return readCookie(req, sessionCookieName(this.cfg));
  }

  async operator(req: Request): Promise<{ operator: OperatorView; actor: string; token: string }> {
    const token = this.token(req);
    const operator = await this.c.operators.resolve(token);
    if (!operator || !token) throw new DomainError('UNAUTHENTICATED');
    return { operator, actor: actorLabel(operator), token };
  }
}

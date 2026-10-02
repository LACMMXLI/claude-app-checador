import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DomainError } from '../common/errors.js';
import type { ResolvedSession } from '../common/tenancy/gate.js';
import type { TenantContext } from '../common/tenancy/tenant-context.js';
import type { Container } from '../container.js';
import type { AccessProfile } from '../modules/auth/rbac.service.js';
import { SessionsService } from '../modules/auth/sessions.service.js';
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

export interface TenantRequest {
  session: ResolvedSession;
  ctx: TenantContext;
  access: AccessProfile;
}

/**
 * Autenticación por petición. El negocio activo y los permisos se calculan EN CADA PETICIÓN a partir
 * de la sesión (sin cachés entre negocios). Ningún dato de la petición puede elegir el tenant.
 */
@Injectable()
export class RequestAuth {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(HTTP_CONFIG) private readonly cfg: HttpConfig,
  ) {}

  token(req: Request): string | null {
    return readCookie(req, sessionCookieName(this.cfg));
  }

  async identity(req: Request): Promise<ResolvedSession> {
    const session = await this.c.sessions.resolve(this.token(req));
    if (!session) throw new DomainError('UNAUTHENTICATED');
    return session;
  }

  async tenant(req: Request): Promise<TenantRequest> {
    const session = await this.identity(req);
    if (!session.organizationId || !session.membershipId) throw new DomainError('NO_ACTIVE_ORGANIZATION');
    const ctx = SessionsService.tenantContext(session, { ip: req.ip, requestId: req.header('x-request-id') ?? undefined });
    const access = await this.c.rbac.loadAccess(ctx, session.membershipId);
    return { session, ctx, access };
  }
}

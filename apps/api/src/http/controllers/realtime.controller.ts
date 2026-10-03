import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { DomainError } from '../../common/errors.js';
import type { ChangeNotice } from '../../common/realtime/notification-hub.js';
import type { Container } from '../../container.js';
import type { AccessProfile } from '../../modules/auth/rbac.service.js';
import { RequestAuth } from '../request-auth.js';
import { CONTAINER, HTTP_CONFIG, type HttpConfig, SSE_DEFAULTS } from '../tokens.js';
import { parse } from '../validation.js';

const streamQuery = z.object({ branchId: z.string().uuid().optional() });

/** Conexiones SSE abiertas por usuario en ESTE proceso (límite D-75). */
const openByUser = new Map<string, number>();

/**
 * Tiempo real del tablero y de la bandeja (D-75). Cada evento es una INVALIDACIÓN con identificadores mínimos
 * (`{id, branchId, op}`), sin nombres ni datos personales: el cliente vuelve a consultar los endpoints normales.
 * El negocio sale de la sesión; las sucursales, del alcance (`attendance.view`), revalidados periódicamente.
 */
@Controller('attendance')
export class RealtimeController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(RequestAuth) private readonly auth: RequestAuth,
    @Inject(HTTP_CONFIG) private readonly cfg: HttpConfig,
  ) {}

  @Get('stream')
  async stream(@Req() req: Request, @Res() res: Response) {
    const cfg = { ...SSE_DEFAULTS, ...this.cfg.sse };
    const first = await this.auth.tenant(req);
    const { branchId } = parse(streamQuery, req.query);
    const scope = first.access.branchesFor('attendance.view');
    if (scope !== 'ALL' && scope.size === 0) throw new DomainError('FORBIDDEN', { permission: 'attendance.view' });
    if (branchId && !first.access.can('attendance.view', branchId)) throw new DomainError('BRANCH_NOT_FOUND');
    if (branchId) await this.c.branches.get(first.ctx, branchId); // otra sucursal ajena al negocio ⇒ 404 (RLS)
    const userId = first.session.userId;
    if ((openByUser.get(userId) ?? 0) >= cfg.maxPerUser) throw new DomainError('SSE_TOO_MANY_CONNECTIONS');
    openByUser.set(userId, (openByUser.get(userId) ?? 0) + 1);

    const organizationId = first.ctx.organizationId;
    let access: AccessProfile = first.access;
    let closed = false;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // proxies (nginx/Traefik) no deben acumular la respuesta
    });
    const send = (event: string, data: unknown) => {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const visible = (n: ChangeNotice) => (n.branchId ? (branchId ? n.branchId === branchId : access.can('attendance.view', n.branchId)) : false);

    const timers: NodeJS.Timeout[] = [];
    let unsubscribe: () => Promise<void> = async () => undefined;
    const finish = () => {
      if (closed) return;
      closed = true;
      timers.forEach(clearInterval);
      openByUser.set(userId, Math.max(0, (openByUser.get(userId) ?? 1) - 1));
      void unsubscribe();
      res.end();
    };
    req.on('close', finish);

    res.write('retry: 5000\n\n');
    try {
      unsubscribe = await this.c.notifications.subscribe(organizationId, {
        onNotice: (n) => {
          if (visible(n)) send(`attendance.${n.kind}`, { id: n.id, branchId: n.branchId, op: n.op });
        },
        onResync: () => send('resync', {}),
      });
    } catch {
      return finish(); // sin canal de avisos el cliente sigue con su polling de respaldo
    }
    send('ready', { resync: true });

    timers.push(setInterval(() => send('ping', {}), cfg.pingMs));
    // revalidación: sesión revocada, membresía desactivada o cambio de negocio ⇒ se cierra; permisos recalculados
    timers.push(
      setInterval(() => {
        this.auth
          .tenant(req)
          .then((t) => {
            if (t.ctx.organizationId !== organizationId) return finish();
            access = t.access;
            if (branchId && !access.can('attendance.view', branchId)) finish();
          })
          .catch(() => finish());
      }, cfg.revalidateMs),
    );
    timers.push(setTimeout(finish, cfg.maxLifetimeMs) as unknown as NodeJS.Timeout);
  }
}

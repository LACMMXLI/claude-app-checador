import { type DynamicModule, type INestApplication, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import type { Container } from './container.js';
import { AuditController } from './http/controllers/audit.controller.js';
import { AuthController } from './http/controllers/auth.controller.js';
import { BranchesController } from './http/controllers/branches.controller.js';
import { EmployeesController } from './http/controllers/employees.controller.js';
import { AttendanceController } from './http/controllers/attendance.controller.js';
import { RealtimeController } from './http/controllers/realtime.controller.js';
import { ReportsController } from './http/controllers/reports.controller.js';
import { KioskDeviceController } from './http/controllers/kiosk-device.controller.js';
import { KiosksController } from './http/controllers/kiosks.controller.js';
import { MembersController } from './http/controllers/members.controller.js';
import { PoliciesController } from './http/controllers/policies.controller.js';
import { SchedulesController } from './http/controllers/schedules.controller.js';
import { ErrorsFilter } from './http/errors.filter.js';
import { HEALTH_CHECK, HealthController } from './http/health.controller.js';
import { RequestAuth } from './http/request-auth.js';
import { CONTAINER, HTTP_CONFIG, type HttpConfig, PG_POOL } from './http/tokens.js';

export interface AppOptions {
  /** Pool del rol `app_user` (NOBYPASSRLS). La API nunca recibe credenciales de plataforma. */
  pool: Pool;
  container: Container;
  http: HttpConfig;
}

/** Al cerrar la app se libera la conexión LISTEN del tiempo real. */
@Injectable()
class RealtimeShutdown implements OnModuleDestroy {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}
  onModuleDestroy() {
    return this.c.notifications.close();
  }
}

@Module({})
export class AppModule {
  static forRoot(options: AppOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        AuthController,
        BranchesController,
        EmployeesController,
        MembersController,
        KiosksController,
        KioskDeviceController,
        PoliciesController,
        AuditController,
        SchedulesController,
        AttendanceController,
        RealtimeController,
    ReportsController,
      ],
      providers: [
        { provide: PG_POOL, useValue: options.pool },
        { provide: CONTAINER, useValue: options.container },
        { provide: HTTP_CONFIG, useValue: options.http },
        { provide: HEALTH_CHECK, useValue: async () => (await options.pool.query('SELECT 1')).rowCount === 1 },
        RequestAuth,
        RealtimeShutdown,
      ],
    };
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Defensa CSRF para la cookie de sesión: toda petición que modifica estado debe traer la cabecera
 * `X-Requested-With: checador` (un formulario de otro sitio no puede enviarla sin preflight CORS).
 * Solo quedan fuera las peticiones con `Authorization: Bearer` (integraciones del dispositivo, sin cookie): el
 * navegador del kiosco usa una cookie (D-56) y por eso también exige la cabecera.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method) || (req.path.startsWith('/api/kiosk/') && (req.header('authorization') ?? '').startsWith('Bearer '))) return next();
  if (req.header('x-requested-with') !== 'checador') {
    res.status(403).json({ error: { code: 'CSRF_CHECK_FAILED', details: {} } });
    return;
  }
  next();
}

export async function createHttpApp(options: AppOptions, logger: false | ('log' | 'warn' | 'error')[] = ['log', 'warn', 'error']): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(options), { logger });
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.use(csrfGuard);
  app.useGlobalFilters(new ErrorsFilter());
  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  express.set('trust proxy', 1); // detrás del proxy de Coolify
  return app;
}

import { type DynamicModule, type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { trustProxyFn } from '@checador/api/platform';
import type { Container } from './container.js';
import { AdminController } from './http/controllers/admin.controller.js';
import { AuthController } from './http/controllers/auth.controller.js';
import { CustomersController } from './http/controllers/customers.controller.js';
import { ErrorsFilter } from './http/errors.filter.js';
import { HealthController } from './http/health.controller.js';
import { RequestAuth } from './http/request-auth.js';
import { CONTAINER, CSRF_HEADER_VALUE, HEALTH_CHECK, HTTP_CONFIG, type HttpConfig } from './http/tokens.js';

export interface AppOptions {
  pool: Pool;
  container: Container;
  http: HttpConfig;
}

@Module({})
export class AppModule {
  static forRoot(options: AppOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, CustomersController, AdminController],
      providers: [
        { provide: CONTAINER, useValue: options.container },
        { provide: HTTP_CONFIG, useValue: options.http },
        { provide: HEALTH_CHECK, useValue: async () => (await options.pool.query('SELECT 1')).rowCount === 1 },
        RequestAuth,
      ],
    };
  }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Defensa CSRF: toda petición que modifica estado debe traer `X-Requested-With: platform` (un formulario ajeno no puede enviarla). */
export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (SAFE.has(req.method)) return next();
  if (req.header('x-requested-with') !== CSRF_HEADER_VALUE) {
    res.status(403).json({ error: { code: 'CSRF_CHECK_FAILED', details: {} } });
    return;
  }
  next();
}

export async function createPlatformApp(options: AppOptions, logger: false | ('log' | 'warn' | 'error')[] = ['log', 'warn', 'error']): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(options), { logger });
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.use(csrfGuard);
  app.useGlobalFilters(new ErrorsFilter());
  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  express.set('trust proxy', trustProxyFn(options.http.trustedProxies ?? { proxies: '', hops: 0 }));
  return app;
}

import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';

export const HEALTH_CHECK = Symbol('HEALTH_CHECK');

/** Healthcheck para Coolify/Docker: confirma que la API llega a PostgreSQL. No expone datos de negocio. */
@Controller()
export class HealthController {
  constructor(@Inject(HEALTH_CHECK) private readonly check: () => Promise<boolean>) {}

  @Get('health')
  async health(): Promise<{ status: 'ok' }> {
    if (!(await this.check().catch(() => false))) throw new ServiceUnavailableException({ status: 'db_unavailable' });
    return { status: 'ok' };
  }
}

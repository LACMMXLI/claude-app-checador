import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { HEALTH_CHECK } from './tokens.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(HEALTH_CHECK) private readonly check: () => Promise<boolean>) {}

  @Get()
  async health() {
    if (!(await this.check().catch(() => false))) throw new ServiceUnavailableException();
    return { status: 'ok' };
  }
}

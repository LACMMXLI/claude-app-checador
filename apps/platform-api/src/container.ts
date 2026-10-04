import type { Pool } from 'pg';
import { PlatformAdminService, PlatformDb } from '@checador/api/platform';
import { AuditService } from './modules/audit.service.js';
import { CustomersService } from './modules/customers.service.js';
import { DashboardService } from './modules/dashboard.service.js';
import { OperatorsService } from './modules/operators.service.js';
import { PlansService } from './modules/plans.service.js';
import { SubscriptionsService } from './modules/subscriptions.service.js';
import { SupportService } from './modules/support.service.js';

export interface ContainerOptions {
  /** Pool del rol `platform_ops` (BYPASSRLS). Solo este servicio lo recibe: la API de clientes jamás. */
  platformPool: Pool;
  clock?: () => Date;
}

/** Raíz de composición de la API de plataforma (servicios simples y testeables, sin decoradores). */
export function createContainer(options: ContainerOptions) {
  const db = new PlatformDb(options.platformPool);
  const admin = new PlatformAdminService(db);
  const plans = new PlansService(db);
  return {
    db,
    operators: new OperatorsService(db, options.clock),
    plans,
    subscriptions: new SubscriptionsService(db, options.clock),
    customers: new CustomersService(db, admin, plans, options.clock),
    audit: new AuditService(db),
    dashboard: new DashboardService(db, options.clock),
    support: new SupportService(db, admin),
  };
}
export type Container = ReturnType<typeof createContainer>;

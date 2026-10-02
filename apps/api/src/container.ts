import type { Pool } from 'pg';
import { Gate } from './common/tenancy/gate.js';
import { TenantDb } from './common/tenancy/tenant-db.js';
import { AuditQueryService } from './modules/audit/audit-query.service.js';
import { AuditService } from './modules/audit/audit.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { InvitationsService } from './modules/auth/invitations.service.js';
import { SessionsService } from './modules/auth/sessions.service.js';
import { KioskDevicesService } from './modules/auth/kiosk-devices.service.js';
import { MembershipsService } from './modules/auth/memberships.service.js';
import { KioskIdentificationService } from './modules/auth/pin-attempts.service.js';
import { RbacService } from './modules/auth/rbac.service.js';
import { BranchesService } from './modules/core/branches.service.js';
import { EmployeesService } from './modules/core/employees.service.js';
import { PoliciesService } from './modules/policies/policies.service.js';
import { SchedulingService } from './modules/scheduling/scheduling.service.js';
import { TemplatesService } from './modules/scheduling/templates.service.js';

export interface ContainerOptions {
  /** Pool del rol `app_user` (NOBYPASSRLS). */
  appPool: Pool;
  pinPepper: string;
  clock?: () => Date;
  pinGenerator?: () => string;
}

/**
 * Raíz de composición de la API (sin decoradores: los servicios son clases simples y testeables).
 * Nota: NO incluye PlatformDb; las operaciones de plataforma solo viven en el CLI.
 */
export function createContainer(options: ContainerOptions) {
  const tenantDb = new TenantDb(options.appPool);
  const gate = new Gate(options.appPool);
  const audit = new AuditService();
  const policies = new PoliciesService(tenantDb, audit);
  const employees = new EmployeesService(tenantDb, audit, {
    pepper: options.pinPepper,
    clock: options.clock,
    pinGenerator: options.pinGenerator,
  });
  const auth = new AuthService(gate);
  const scheduling = new SchedulingService(tenantDb, audit, policies, options.clock);
  return {
    tenantDb,
    gate,
    audit,
    policies,
    employees,
    branches: new BranchesService(tenantDb, audit),
    memberships: new MembershipsService(tenantDb, audit),
    rbac: new RbacService(tenantDb),
    auth,
    sessions: new SessionsService(gate, auth),
    invitations: new InvitationsService(tenantDb, gate, audit),
    auditQuery: new AuditQueryService(tenantDb),
    scheduling,
    templates: new TemplatesService(tenantDb, audit, scheduling),
    kiosks: new KioskDevicesService(tenantDb, gate, audit),
    kioskIdentification: new KioskIdentificationService(tenantDb, employees, policies, audit, options.clock),
  };
}
export type Container = ReturnType<typeof createContainer>;

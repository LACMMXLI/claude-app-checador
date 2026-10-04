import type { Pool } from 'pg';
import { NotificationHub } from './common/realtime/notification-hub.js';
import { Gate } from './common/tenancy/gate.js';
import { TenantDb } from './common/tenancy/tenant-db.js';
import { AuditQueryService } from './modules/audit/audit-query.service.js';
import { AuditService } from './modules/audit/audit.service.js';
import { EntitlementsService } from './modules/subscription/entitlements.service.js';
import { ReportsService } from './modules/reports/reports.service.js';
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
import { AttendanceQueryService } from './modules/attendance/attendance-query.service.js';
import { CorrectionsService } from './modules/attendance/corrections.service.js';
import { CorrectionRequestsService } from './modules/attendance/correction-requests.service.js';
import { KioskAttendanceService } from './modules/attendance/kiosk-attendance.service.js';
import { KioskTickets } from './modules/attendance/kiosk-ticket.js';
import { ReconcilerService } from './modules/attendance/reconciler.service.js';

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
  const entitlements = new EntitlementsService(tenantDb);
  const policies = new PoliciesService(tenantDb, audit, options.clock);
  const employees = new EmployeesService(tenantDb, audit, {
    pepper: options.pinPepper,
    clock: options.clock,
    pinGenerator: options.pinGenerator,
  });
  const auth = new AuthService(gate);
  const scheduling = new SchedulingService(tenantDb, audit, policies, options.clock);
  const kioskIdentification = new KioskIdentificationService(tenantDb, employees, policies, audit, options.clock);
  const reconciler = new ReconcilerService(tenantDb, gate, audit, policies, options.clock);
  const corrections = new CorrectionsService(tenantDb, audit, policies, options.clock);
  const correctionRequests = new CorrectionRequestsService(tenantDb, audit, policies, corrections, options.clock);
  return {
    tenantDb,
    gate,
    audit,
    policies,
    employees,
    branches: new BranchesService(tenantDb, audit, options.clock),
    memberships: new MembershipsService(tenantDb, audit),
    rbac: new RbacService(tenantDb),
    auth,
    sessions: new SessionsService(gate, auth),
    entitlements,
    invitations: new InvitationsService(tenantDb, gate, audit, undefined, entitlements),
    auditQuery: new AuditQueryService(tenantDb),
    scheduling,
    templates: new TemplatesService(tenantDb, audit, scheduling),
    kiosks: new KioskDevicesService(tenantDb, gate, audit),
    kioskIdentification,
    reconciler,
    // El pase corto del kiosco se firma con una clave DERIVADA del secreto del servidor (separación de dominio).
    kioskAttendance: new KioskAttendanceService(tenantDb, audit, policies, kioskIdentification, reconciler, new KioskTickets(options.pinPepper), correctionRequests, options.clock),
    corrections,
    correctionRequests,
    attendanceQuery: new AttendanceQueryService(tenantDb, policies, options.clock),
    reports: new ReportsService(tenantDb, policies, audit, options.clock),
    // Avisos de cambio para SSE (D-75): LISTEN por negocio sobre una conexión del pool de app_user
    notifications: new NotificationHub(options.appPool),
  };
}
export type Container = ReturnType<typeof createContainer>;

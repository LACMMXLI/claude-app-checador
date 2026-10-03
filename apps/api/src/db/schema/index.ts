import {
  bigint,
  smallint,
  boolean,
  date,
  integer,
  jsonb,
  pgSchema,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Esquema Drizzle (consultas tipadas). La FUENTE DE VERDAD son las migraciones SQL en `db/migrations`
 * (RLS, constraints, índices, triggers y exclusiones viven allí). `test/schema-drift.test.ts` verifica
 * que estas definiciones coincidan con la base de datos migrada.
 */
const platform = pgSchema('platform');
const auth = pgSchema('auth');
const core = pgSchema('core');
const audit = pgSchema('audit');
const scheduling = pgSchema('scheduling');
const attendance = pgSchema('attendance');

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ── platform ───────────────────────────────────────────────────────────────────
export const policyDefaults = platform.table('policy_defaults', {
  id: boolean('id').primaryKey().default(true),
  entryToleranceMin: integer('entry_tolerance_min').notNull(),
  exitToleranceMin: integer('exit_tolerance_min').notNull(),
  maxBreaks: integer('max_breaks').notNull(),
  breakAllowedMin: integer('break_allowed_min').notNull(),
  breakToleranceMin: integer('break_tolerance_min').notNull(),
  requireBreak: boolean('require_break').notNull(),
  earlyEntryWindowMin: integer('early_entry_window_min').notNull(),
  absentAfterMin: integer('absent_after_min').notNull(),
  operationalCutoff: time('operational_cutoff').notNull(),
  maxOpenSessionMinutes: integer('max_open_session_minutes').notNull(),
  debounceSec: integer('debounce_sec').notNull(),
  pinMaxAttempts: integer('pin_max_attempts').notNull(),
  pinLockoutSec: integer('pin_lockout_sec').notNull(),
  pinLockoutMaxSec: integer('pin_lockout_max_sec').notNull(),
  weekStartDay: integer('week_start_day').notNull(),
  shiftMinMinutes: integer('shift_min_minutes').notNull(),
  shiftMaxMinutes: integer('shift_max_minutes').notNull(),
  breakRequiredAfterMin: integer('break_required_after_min').notNull(),
  correctionRequestWindowDays: integer('correction_request_window_days').notNull(),
  maxPendingCorrectionRequests: integer('max_pending_correction_requests').notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const platformAuditLog = platform.table('platform_audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  occurredAt: tstz('occurred_at').notNull().defaultNow(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  organizationId: uuid('organization_id'),
  details: jsonb('details').notNull().default({}),
});

// ── auth ───────────────────────────────────────────────────────────────────────
export const users = auth.table('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const sessions = auth.table('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull(),
  userId: uuid('user_id').notNull(),
  organizationId: uuid('organization_id'),
  membershipId: uuid('membership_id'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  expiresAt: tstz('expires_at').notNull(),
  revokedAt: tstz('revoked_at'),
  ip: text('ip'),
  userAgent: text('user_agent'),
});

export const userCredentials = auth.table('user_credentials', {
  userId: uuid('user_id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  passwordChangedAt: tstz('password_changed_at').notNull().defaultNow(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: tstz('locked_until'),
});

// ── core ───────────────────────────────────────────────────────────────────────
export const organizations = core.table('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull(),
  branding: jsonb('branding').notNull().default({}),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const branches = core.table('branches', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  timezone: text('timezone'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const employees = core.table('employees', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  employeeNumber: text('employee_number').notNull(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull().default(''),
  phone: text('phone'),
  notes: text('notes'),
  status: text('status').notNull().default('ACTIVE'),
  hiredAt: date('hired_at', { mode: 'string' }),
  terminatedAt: date('terminated_at', { mode: 'string' }),
  terminationReason: text('termination_reason'),
  pinHash: text('pin_hash'),
  pinSetAt: tstz('pin_set_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const employeeBranchAssignments = core.table('employee_branch_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  kind: text('kind').notNull(),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }),
  reason: text('reason'),
  createdBy: uuid('created_by'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const permissions = core.table('permissions', {
  code: text('code').primaryKey(),
  description: text('description').notNull(),
});

export const roles = core.table('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  name: text('name').notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const rolePermissions = core.table('role_permissions', {
  organizationId: uuid('organization_id').notNull(),
  roleId: uuid('role_id').notNull(),
  permissionCode: text('permission_code').notNull(),
});

export const organizationMemberships = core.table('organization_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  userId: uuid('user_id').notNull(),
  employeeId: uuid('employee_id'),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const roleAssignments = core.table('role_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  roleId: uuid('role_id').notNull(),
  scope: text('scope').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const roleAssignmentBranches = core.table('role_assignment_branches', {
  organizationId: uuid('organization_id').notNull(),
  assignmentId: uuid('assignment_id').notNull(),
  branchId: uuid('branch_id').notNull(),
});

export const invitations = core.table('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  email: text('email').notNull(),
  roleId: uuid('role_id').notNull(),
  scope: text('scope').notNull(),
  branchIds: uuid('branch_ids').array().notNull().default([]),
  tokenHash: text('token_hash').notNull(),
  expiresAt: tstz('expires_at').notNull(),
  acceptedAt: tstz('accepted_at'),
  acceptedUserId: uuid('accepted_user_id'),
  revokedAt: tstz('revoked_at'),
  createdBy: uuid('created_by'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const kioskDevices = core.table('kiosk_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  name: text('name').notNull(),
  tokenPrefix: text('token_prefix'),
  tokenHash: text('token_hash'),
  tokenIssuedAt: tstz('token_issued_at'),
  tokenRevokedAt: tstz('token_revoked_at'),
  status: text('status').notNull().default('ACTIVE'),
  lastSeenAt: tstz('last_seen_at'),
  activatedAt: tstz('activated_at'),
  lastSeenIp: text('last_seen_ip'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const kioskPairingCodes = core.table('kiosk_pairing_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: tstz('expires_at').notNull(),
  usedAt: tstz('used_at'),
  createdBy: uuid('created_by'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const pinAttempts = core.table('pin_attempts', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  organizationId: uuid('organization_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  attemptedAt: tstz('attempted_at').notNull().defaultNow(),
  success: boolean('success').notNull(),
  employeeId: uuid('employee_id'),
});

export const policyOverrides = core.table('policy_overrides', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  scope: text('scope').notNull(),
  branchId: uuid('branch_id'),
  employeeId: uuid('employee_id'),
  entryToleranceMin: integer('entry_tolerance_min'),
  exitToleranceMin: integer('exit_tolerance_min'),
  maxBreaks: integer('max_breaks'),
  breakAllowedMin: integer('break_allowed_min'),
  breakToleranceMin: integer('break_tolerance_min'),
  requireBreak: boolean('require_break'),
  earlyEntryWindowMin: integer('early_entry_window_min'),
  absentAfterMin: integer('absent_after_min'),
  operationalCutoff: time('operational_cutoff'),
  maxOpenSessionMinutes: integer('max_open_session_minutes'),
  debounceSec: integer('debounce_sec'),
  pinMaxAttempts: integer('pin_max_attempts'),
  pinLockoutSec: integer('pin_lockout_sec'),
  pinLockoutMaxSec: integer('pin_lockout_max_sec'),
  weekStartDay: integer('week_start_day'),
  shiftMinMinutes: integer('shift_min_minutes'),
  shiftMaxMinutes: integer('shift_max_minutes'),
  breakRequiredAfterMin: integer('break_required_after_min'),
  correctionRequestWindowDays: integer('correction_request_window_days'),
  maxPendingCorrectionRequests: integer('max_pending_correction_requests'),
  updatedBy: uuid('updated_by'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

// ── audit ──────────────────────────────────────────────────────────────────────
export const auditLog = audit.table('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id'),
  occurredAt: tstz('occurred_at').notNull().defaultNow(),
  actorType: text('actor_type').notNull(),
  actorUserId: uuid('actor_user_id'),
  actorDeviceId: uuid('actor_device_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  reason: text('reason'),
  ip: text('ip'),
  requestId: text('request_id'),
});

// ── scheduling (Fase 2) ────────────────────────────────────────────────────────
export const weeklySchedules = scheduling.table('weekly_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  weekStart: date('week_start', { mode: 'string' }).notNull(),
  status: text('status').notNull().default('DRAFT'),
  version: integer('version').notNull().default(1),
  publishedAt: tstz('published_at'),
  publishedBy: uuid('published_by'),
  createdBy: uuid('created_by'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const shifts = scheduling.table('shifts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  scheduleId: uuid('schedule_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  startsAt: tstz('starts_at').notNull(),
  endsAt: tstz('ends_at').notNull(),
  timezoneSnapshot: text('timezone_snapshot').notNull(),
  scheduledMinutes: integer('scheduled_minutes').generatedAlwaysAs(sql`((EXTRACT(EPOCH FROM (ends_at - starts_at)) / 60)::integer)`),
  status: text('status').notNull().default('SCHEDULED'),
  cancelledAt: tstz('cancelled_at'),
  cancelledBy: uuid('cancelled_by'),
  cancelReason: text('cancel_reason'),
  notes: text('notes'),
  source: text('source').notNull().default('MANUAL'),
  sourceShiftId: uuid('source_shift_id'),
  sourceTemplateId: uuid('source_template_id'),
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const scheduleTemplates = scheduling.table('schedule_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const scheduleTemplateEntries = scheduling.table('schedule_template_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  templateId: uuid('template_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  weekday: smallint('weekday').notNull(),
  startLocal: time('start_local').notNull(),
  endLocal: time('end_local').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// ── attendance (Fase 3) ────────────────────────────────────────────────────────
export const workSessions = attendance.table('work_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  shiftId: uuid('shift_id'),
  operationalDate: date('operational_date', { mode: 'string' }).notNull(),
  startedAt: tstz('started_at').notNull(),
  endedAt: tstz('ended_at'),
  status: text('status').notNull().default('OPEN'),
  origin: text('origin').notNull(),
  policySnapshot: jsonb('policy_snapshot').notNull().default({}),
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const breaks = attendance.table('breaks', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  workSessionId: uuid('work_session_id').notNull(),
  sequence: smallint('sequence').notNull(),
  startedAt: tstz('started_at').notNull(),
  endedAt: tstz('ended_at'),
  allowedMinutes: integer('allowed_minutes').notNull(),
  toleranceMinutes: integer('tolerance_minutes').notNull().default(0),
  durationMinutes: integer('duration_minutes').generatedAlwaysAs(sql`CASE WHEN ended_at IS NULL THEN NULL ELSE attendance.minutes_between(started_at, ended_at) END`),
  exceededMinutes: integer('exceeded_minutes').generatedAlwaysAs(sql`CASE WHEN ended_at IS NULL THEN NULL ELSE GREATEST(0, attendance.minutes_between(started_at, ended_at) - allowed_minutes - tolerance_minutes) END`),
  origin: text('origin').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const attendanceEvents = attendance.table('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  workSessionId: uuid('work_session_id').notNull(),
  breakId: uuid('break_id'),
  type: text('type').notNull(),
  clientEventId: uuid('client_event_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  occurredAt: tstz('occurred_at').notNull(),
  receivedAt: tstz('received_at').notNull().defaultNow(),
  source: text('source').notNull().default('KIOSK_ONLINE'),
  timeSource: text('time_source').notNull().default('SERVER'),
});

export const incidents = attendance.table('incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  workSessionId: uuid('work_session_id'),
  shiftId: uuid('shift_id'),
  operationalDate: date('operational_date', { mode: 'string' }).notNull(),
  type: text('type').notNull(),
  status: text('status').notNull().default('OPEN'),
  details: jsonb('details').notNull().default({}),
  detectedAt: tstz('detected_at').notNull().defaultNow(),
  detectedBy: text('detected_by').notNull(),
  resolution: text('resolution'),
  resolvedAt: tstz('resolved_at'),
  resolvedBy: uuid('resolved_by'),
  resolutionReason: text('resolution_reason'),
  resolutionCorrectionId: uuid('resolution_correction_id'),
  resolutionSource: text('resolution_source'),
  version: integer('version').notNull().default(1),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const corrections = attendance.table('corrections', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  workSessionId: uuid('work_session_id').notNull(),
  breakId: uuid('break_id'),
  incidentId: uuid('incident_id'),
  action: text('action').notNull(),
  originalValue: jsonb('original_value'),
  correctedValue: jsonb('corrected_value').notNull(),
  before: jsonb('before'),
  after: jsonb('after').notNull(),
  reason: text('reason').notNull(),
  correctedBy: uuid('corrected_by').notNull(),
  correctedAt: tstz('corrected_at').notNull().defaultNow(),
  requestId: uuid('request_id'),
});

export const correctionRequests = attendance.table('correction_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  operationalDate: date('operational_date', { mode: 'string' }).notNull(),
  action: text('action').notNull(),
  workSessionId: uuid('work_session_id'),
  breakId: uuid('break_id'),
  shiftId: uuid('shift_id'),
  incidentId: uuid('incident_id'),
  proposedStart: tstz('proposed_start').notNull(),
  proposedEnd: tstz('proposed_end'),
  proposedLocal: jsonb('proposed_local').notNull().default({}),
  reason: text('reason').notNull(),
  channel: text('channel').notNull(),
  requestedByUserId: uuid('requested_by_user_id'),
  requestedDeviceId: uuid('requested_device_id'),
  clientRequestId: uuid('client_request_id').notNull(),
  status: text('status').notNull().default('PENDING'),
  decidedBy: uuid('decided_by'),
  decidedAt: tstz('decided_at'),
  decisionReason: text('decision_reason'),
  correctionId: uuid('correction_id'),
  sessionVersionAtRequest: integer('session_version_at_request'),
  version: integer('version').notNull().default(1),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

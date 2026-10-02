import {
  bigint,
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

/**
 * Esquema Drizzle (consultas tipadas). La FUENTE DE VERDAD son las migraciones SQL en `db/migrations`
 * (RLS, constraints, índices, triggers y exclusiones viven allí). `test/schema-drift.test.ts` verifica
 * que estas definiciones coincidan con la base de datos migrada.
 */
const platform = pgSchema('platform');
const auth = pgSchema('auth');
const core = pgSchema('core');
const audit = pgSchema('audit');

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
  maxHoursUnscheduled: integer('max_hours_unscheduled').notNull(),
  debounceSec: integer('debounce_sec').notNull(),
  pinMaxAttempts: integer('pin_max_attempts').notNull(),
  pinLockoutSec: integer('pin_lockout_sec').notNull(),
  pinLockoutMaxSec: integer('pin_lockout_max_sec').notNull(),
  weekStartDay: integer('week_start_day').notNull(),
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
  maxHoursUnscheduled: integer('max_hours_unscheduled'),
  debounceSec: integer('debounce_sec'),
  pinMaxAttempts: integer('pin_max_attempts'),
  pinLockoutSec: integer('pin_lockout_sec'),
  pinLockoutMaxSec: integer('pin_lockout_max_sec'),
  weekStartDay: integer('week_start_day'),
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

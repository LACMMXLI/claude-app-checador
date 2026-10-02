import { desc, eq } from 'drizzle-orm';
import { DomainError } from '../../common/errors.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';
import { pinAttempts } from '../../db/schema/index.js';
import type { AuditService } from '../audit/audit.service.js';
import type { EmployeesService, EmployeeView } from '../core/employees.service.js';
import type { PoliciesService } from '../policies/policies.service.js';

export interface PinThrottlePolicy {
  pinMaxAttempts: number;
  pinLockoutSec: number;
  pinLockoutMaxSec: number;
}

/**
 * D-21 · Pausa corta y progresiva POR DISPOSITIVO (el kiosco es compartido: un abuso no debe dejarlo
 * inutilizable). Con n fallos consecutivos (desde el último acierto en ese kiosco):
 *   n < pinMaxAttempts            → sin pausa
 *   n ≥ pinMaxAttempts            → pausa = min(pinLockoutSec · 2^(n − pinMaxAttempts), pinLockoutMaxSec)
 * Por defecto: 5 fallos → 10 s; 6 → 20 s; 7 → 40 s; 8 → 80 s; 9+ → 120 s (tope configurable, máx. 300 s).
 * Devuelve los segundos que faltan de pausa (0 = libre).
 */
export function pinPauseRemainingSec(
  consecutiveFailures: number,
  lastFailureAt: Date | null,
  policy: PinThrottlePolicy,
  now: Date,
): number {
  const duration = pinPauseDurationSec(consecutiveFailures, policy);
  if (duration === 0 || !lastFailureAt) return 0;
  return Math.max(0, Math.ceil((lastFailureAt.getTime() + duration * 1000 - now.getTime()) / 1000));
}

export function pinPauseDurationSec(consecutiveFailures: number, policy: PinThrottlePolicy): number {
  if (consecutiveFailures < policy.pinMaxAttempts) return 0;
  const exponent = Math.min(consecutiveFailures - policy.pinMaxAttempts, 20);
  return Math.min(policy.pinLockoutSec * 2 ** exponent, policy.pinLockoutMaxSec);
}

/**
 * Identificación por PIN en el kiosco. Todo intento se registra (sin guardar el PIN intentado) y
 * cada pausa que se activa queda en la auditoría como evento de seguridad. Errores genéricos.
 */
export class KioskIdentificationService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly employees: EmployeesService,
    private readonly policies: PoliciesService,
    private readonly audit: AuditService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async consecutiveFailures(tx: Tx, deviceId: string): Promise<{ count: number; last: Date | null }> {
    const recent = await tx.select().from(pinAttempts).where(eq(pinAttempts.deviceId, deviceId)).orderBy(desc(pinAttempts.id)).limit(200);
    let count = 0;
    for (const attempt of recent) {
      if (attempt.success) break;
      count += 1;
    }
    return { count, last: count > 0 ? recent[0]!.attemptedAt : null };
  }

  async identify(ctx: TenantContext, branchId: string, pin: string): Promise<EmployeeView> {
    const deviceId = ctx.actor.deviceId;
    if (ctx.actor.type !== 'KIOSK' || !deviceId) throw new DomainError('KIOSK_CONTEXT_REQUIRED');
    // El intento debe PERSISTIR aunque se rechace: el error se lanza después de confirmar la transacción.
    const outcome = await this.tenantDb.run(ctx, async (tx) => {
      const { policy } = await this.policies.getEffectiveTx(tx, ctx, { branchId });
      const { count, last } = await this.consecutiveFailures(tx, deviceId);
      const now = this.clock();
      const remaining = pinPauseRemainingSec(count, last, policy, now);
      if (remaining > 0) return { paused: remaining } as const;

      const employee = await this.employees.findActiveByPin(tx, ctx, pin);
      await tx.insert(pinAttempts).values({
        organizationId: ctx.organizationId,
        deviceId,
        attemptedAt: now,
        success: employee !== null,
        employeeId: employee?.id ?? null,
      });
      if (!employee) {
        const pause = pinPauseDurationSec(count + 1, policy);
        if (pause > 0) {
          await this.audit.record(tx, ctx, {
            action: 'security.pin_pause_started', // evento sospechoso: sin PIN, solo el conteo y la pausa
            entityType: 'kiosk_device',
            entityId: deviceId,
            branchId,
            after: { consecutiveFailures: count + 1, pauseSec: pause },
          });
        }
      }
      return { employee } as const;
    });
    if ('paused' in outcome) throw new DomainError('PIN_PAUSED', { retryAfterSec: outcome.paused });
    if (!outcome.employee) throw new DomainError('INVALID_PIN');
    return outcome.employee;
  }
}

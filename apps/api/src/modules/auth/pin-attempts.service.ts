import { desc, eq } from 'drizzle-orm';
import { DomainError } from '../../common/errors.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { Tx, TenantDb } from '../../common/tenancy/tenant-db.js';
import { pinAttempts } from '../../db/schema/index.js';
import type { EmployeesService, EmployeeView } from '../core/employees.service.js';
import type { PoliciesService } from '../policies/policies.service.js';

const MAX_LOCKOUT_SEC = 3600;

/**
 * Bloqueo con retroceso exponencial: cada `pinMaxAttempts` fallos consecutivos en un kiosco se bloquea
 * `pinLockoutSec` · 2^(k-1) segundos (tope 1 h), donde k = fallos / pinMaxAttempts. Un acierto reinicia.
 * Devuelve los segundos restantes de bloqueo (0 = libre).
 */
export function lockoutRemainingSec(
  consecutiveFailures: number,
  lastFailureAt: Date | null,
  policy: { pinMaxAttempts: number; pinLockoutSec: number },
  now: Date,
): number {
  if (consecutiveFailures === 0 || !lastFailureAt || consecutiveFailures % policy.pinMaxAttempts !== 0) return 0;
  const k = consecutiveFailures / policy.pinMaxAttempts;
  const duration = Math.min(policy.pinLockoutSec * 2 ** (k - 1), MAX_LOCKOUT_SEC);
  return Math.max(0, Math.ceil((lastFailureAt.getTime() + duration * 1000 - now.getTime()) / 1000));
}

/**
 * Identificación por PIN en el kiosco con protección contra intentos masivos. Todo intento se
 * registra (sin guardar el PIN intentado). Errores genéricos: no revela si el PIN existe.
 */
export class KioskIdentificationService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly employees: EmployeesService,
    private readonly policies: PoliciesService,
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
    // El intento (acierto o fallo) debe PERSISTIR aunque se rechace: por eso el error se lanza
    // después de confirmar la transacción y no dentro de ella.
    const outcome = await this.tenantDb.run(ctx, async (tx) => {
      const { policy } = await this.policies.getEffectiveTx(tx, ctx, { branchId });
      const { count, last } = await this.consecutiveFailures(tx, deviceId);
      const remaining = lockoutRemainingSec(count, last, policy, this.clock());
      if (remaining > 0) return { locked: remaining } as const;

      const employee = await this.employees.findActiveByPin(tx, ctx, pin);
      await tx.insert(pinAttempts).values({
        organizationId: ctx.organizationId,
        deviceId,
        attemptedAt: this.clock(),
        success: employee !== null,
        employeeId: employee?.id ?? null,
      });
      return { employee } as const;
    });
    if ('locked' in outcome) throw new DomainError('PIN_LOCKED', { retryAfterSec: outcome.locked });
    if (!outcome.employee) throw new DomainError('INVALID_PIN');
    return outcome.employee;
  }
}

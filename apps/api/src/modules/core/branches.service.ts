import { asc, eq, inArray } from 'drizzle-orm';
import { DomainError, isPgError } from '../../common/errors.js';
import { effectiveTimezone, isValidTimezone } from '../../common/time.js';
import type { TenantContext } from '../../common/tenancy/tenant-context.js';
import type { TenantDb } from '../../common/tenancy/tenant-db.js';
import { branches, organizations } from '../../db/schema/index.js';
import type { AuditService } from '../audit/audit.service.js';

export class BranchesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async create(ctx: TenantContext, input: { code: string; name: string; timezone?: string | null }) {
    if (input.timezone && !isValidTimezone(input.timezone)) throw new DomainError('TIMEZONE_INVALID');
    return this.tenantDb.run(ctx, async (tx) => {
      try {
        const [branch] = await tx
          .insert(branches)
          .values({ organizationId: ctx.organizationId, code: input.code, name: input.name, timezone: input.timezone ?? null })
          .returning();
        await this.audit.record(tx, ctx, {
          action: 'branch.created',
          entityType: 'branch',
          entityId: branch!.id,
          branchId: branch!.id,
          after: branch,
        });
        return branch!;
      } catch (error) {
        if (isPgError(error, '23505')) throw new DomainError('BRANCH_CODE_TAKEN');
        throw error;
      }
    });
  }

  /** `timezone: null` quita la sobrescritura y la sucursal vuelve a heredar la del negocio. */
  async update(
    ctx: TenantContext,
    branchId: string,
    patch: { name?: string; timezone?: string | null; isActive?: boolean },
    reason?: string,
  ) {
    if (patch.timezone && !isValidTimezone(patch.timezone)) throw new DomainError('TIMEZONE_INVALID');
    return this.tenantDb.run(ctx, async (tx) => {
      const [before] = await tx.select().from(branches).where(eq(branches.id, branchId));
      if (!before) throw new DomainError('BRANCH_NOT_FOUND');
      const [after] = await tx.update(branches).set(patch).where(eq(branches.id, branchId)).returning();
      await this.audit.record(tx, ctx, {
        action: 'branch.updated',
        entityType: 'branch',
        entityId: branchId,
        branchId,
        before,
        after,
        reason,
      });
      return after!;
    });
  }

  /** Lista las sucursales del negocio; `scope` limita a las del alcance del usuario. Incluye la zona efectiva. */
  async list(ctx: TenantContext, scope: 'ALL' | ReadonlySet<string>) {
    return this.tenantDb.run(ctx, async (tx) => {
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, ctx.organizationId));
      if (scope !== 'ALL' && scope.size === 0) return [];
      const rows = await tx
        .select()
        .from(branches)
        .where(scope === 'ALL' ? undefined : inArray(branches.id, [...scope]))
        .orderBy(asc(branches.name));
      return rows.map((b) => ({ ...b, effectiveTimezone: effectiveTimezone(b.timezone, org!.timezone) }));
    });
  }

  async get(ctx: TenantContext, branchId: string) {
    return this.tenantDb.run(ctx, async (tx) => {
      const [branch] = await tx.select().from(branches).where(eq(branches.id, branchId));
      if (!branch) throw new DomainError('BRANCH_NOT_FOUND');
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, ctx.organizationId));
      return { ...branch, effectiveTimezone: effectiveTimezone(branch.timezone, org!.timezone) };
    });
  }

  /** Zona efectiva = la de la sucursal si la sobrescribe; si no, la del negocio. */
  async getEffectiveTimezone(ctx: TenantContext, branchId: string): Promise<string> {
    return this.tenantDb.run(ctx, async (tx) => {
      const [branch] = await tx.select().from(branches).where(eq(branches.id, branchId));
      if (!branch) throw new DomainError('BRANCH_NOT_FOUND');
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, ctx.organizationId));
      if (!org) throw new DomainError('ORGANIZATION_NOT_FOUND');
      return effectiveTimezone(branch.timezone, org.timezone);
    });
  }
}

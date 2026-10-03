import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { operationalDateIn } from '../../common/operational-day.js';
import type { Tx } from '../../common/tenancy/tenant-db.js';
import { shifts, workSessions } from '../../db/schema/index.js';
import { organizationCalendars } from '../policies/operational-calendar.js';

/**
 * D-78 · Al cambiar la hora de corte o la zona de una sucursal, los turnos que AÚN NO EMPIEZAN se recalculan con el
 * calendario nuevo (los cambios de política aplican hacia adelante, RN-CAL-05). Lo ya ocurrido conserva su día.
 * Filtra por `organizationId` explícitamente: sirve dentro de un negocio (RLS) y desde el CLI de plataforma.
 */
export async function refreshFutureShiftOperationalDates(tx: Tx, organizationId: string, now: Date, branchIds?: readonly string[]): Promise<number> {
  const calendars = await organizationCalendars(tx, organizationId);
  const rows = await tx
    .select({ id: shifts.id, branchId: shifts.branchId, startsAt: shifts.startsAt, operationalDate: shifts.operationalDate })
    .from(shifts)
    .leftJoin(workSessions, eq(workSessions.shiftId, shifts.id))
    .where(
      and(
        eq(shifts.organizationId, organizationId),
        eq(shifts.status, 'SCHEDULED'),
        gt(shifts.startsAt, now),
        isNull(workSessions.id),
        branchIds ? inArray(shifts.branchId, [...branchIds]) : undefined,
      ),
    );
  let changed = 0;
  for (const r of rows) {
    const calendar = calendars.branches.get(r.branchId);
    if (!calendar) continue;
    const next = operationalDateIn(r.startsAt, calendar);
    if (next === r.operationalDate) continue;
    await tx.update(shifts).set({ operationalDate: next }).where(eq(shifts.id, r.id));
    changed += 1;
  }
  return changed;
}

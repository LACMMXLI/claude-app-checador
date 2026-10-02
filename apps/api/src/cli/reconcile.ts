import { requireEnv } from '../config/env.js';
import { Gate } from '../common/tenancy/gate.js';
import { TenantDb } from '../common/tenancy/tenant-db.js';
import { createPool } from '../db/pool.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { ReconcilerService } from '../modules/attendance/reconciler.service.js';
import { PoliciesService } from '../modules/policies/policies.service.js';

/**
 * Reconciliación de asistencia (D-44): faltas definitivas, jornadas abiertas al corte, jornadas sin turno
 * demasiado largas y pausas abiertas. Idempotente: se puede ejecutar cada minuto o a mano.
 * Usa la MISMA conexión que la API (`app_user`, sin BYPASSRLS): cada negocio en su propio contexto.
 *   node dist/src/cli/reconcile.js        (en el contenedor de la API)
 *   pnpm --filter @checador/api reconcile (desarrollo)
 */
const pool = createPool(requireEnv('DATABASE_URL'));
try {
  const tenantDb = new TenantDb(pool);
  const audit = new AuditService();
  const reconciler = new ReconcilerService(tenantDb, new Gate(pool), audit, new PoliciesService(tenantDb, audit));
  const { results, errors } = await reconciler.reconcileAll();
  const total = results.reduce(
    (t, r) => ({ absences: t.absences + r.absences, forgottenExits: t.forgottenExits + r.forgottenExits, longOpenSessions: t.longOpenSessions + r.longOpenSessions, openBreaks: t.openBreaks + r.openBreaks }),
    { absences: 0, forgottenExits: 0, longOpenSessions: 0, openBreaks: 0 },
  );
  console.log(JSON.stringify({ at: new Date().toISOString(), organizations: results.length, ...total, errors: errors.length }));
  for (const e of errors) console.error(`✖ negocio ${e.organizationId}: ${e.error}`);
  if (errors.length) process.exitCode = 1;
} finally {
  await pool.end();
}

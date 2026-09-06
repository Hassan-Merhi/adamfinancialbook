import 'dotenv/config';
import { getConfig } from './config.js';
import { fireOperationalAlert, logOperationalEvent } from './alerts.js';

const config = getConfig();
logOperationalEvent('startup.validation.ok', {
  nodeEnv: config.NODE_ENV,
  node: process.version,
  port: config.PORT,
  pgssl: config.PGSSL,
});

const { getMigrationStatus, runMigrations } = await import('./migration.js');

try {
  const applied = await runMigrations();
  if (applied.length) logOperationalEvent('database.migrated', { applied });

  const status = await getMigrationStatus();
  if (status.pending.length) {
    throw new Error(`Database is not ready: ${status.pending.length} migration(s) remain pending.`);
  }
  const { ensureOperationsSchema } = await import('./operations-schema.js');
  await ensureOperationsSchema();
  logOperationalEvent('database.ready', {
    currentMigration: status.current,
    latestMigration: status.latest,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fireOperationalAlert('database.migration.failed', { error: message }, 'critical', 0);
  throw error;
}

const [
  { delegationGate },
  { expenseReviewRouter },
  { resetRouter },
  { operationsRouter },
  { requestTelemetry },
  { healthRouter },
  { publicSecurityRouter },
] = await Promise.all([
  import('./delegation.js'),
  import('./expense-review.js'),
  import('./reset.js'),
  import('./operations.js'),
  import('./observability.js'),
  import('./health.js'),
  import('./security-gate.js'),
]);

publicSecurityRouter.use(healthRouter);
// publicSecurityRouter is mounted before requireAuthenticatedApi. Its fixed
// public routes finish first; this fallthrough therefore observes every other
// /api request before protected/delegated/core routing can finish it.
publicSecurityRouter.use(requestTelemetry);
delegationGate.use(expenseReviewRouter);
delegationGate.use(resetRouter);
delegationGate.use(operationsRouter);

await import('./index.js');

const { startIntegrityMonitor } = await import('./integrity.js');
startIntegrityMonitor();

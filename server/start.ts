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
  { backupExportRouter },
  { publicSecurityRouter, protectedSecurityRouter },
  { liveUpdatesRouter, liveMutationObserver, liveSecuritySessionObserver },
  { offlineSyncRouter },
  { offlineRevisionRouter },
  { offlineSetupRouter },
  { handoffConfirmationSafetyRouter },
  { offlineAttachmentRouter },
] = await Promise.all([
  import('./delegation.js'),
  import('./expense-review.js'),
  import('./reset.js'),
  import('./operations.js'),
  import('./observability.js'),
  import('./health.js'),
  import('./backup-export.js'),
  import('./security-gate.js'),
  import('./live-updates.js'),
  import('./offline-sync.js'),
  import('./offline-revisions.js'),
  import('./offline-setup.js'),
  import('./handoff-confirmation-safety.js'),
  import('./offline-attachments.js'),
]);

publicSecurityRouter.use(healthRouter);
// GitHub-hosted Actions authenticate these narrow machine-to-machine routes with
// a short-lived signed OIDC identity. No session cookie, database credential,
// or backup encryption key ever leaves the production service.
publicSecurityRouter.use(backupExportRouter);
// publicSecurityRouter is mounted after loadSecuritySession but before
// requireAuthenticatedApi. Fixed public routes finish first; this fallthrough
// therefore observes all later successful writes, including the protected
// security routes that terminate inside protectedSecurityRouter.
publicSecurityRouter.use(requestTelemetry);
publicSecurityRouter.use(liveMutationObserver);
publicSecurityRouter.use(liveSecuritySessionObserver);
// The SSE endpoint itself stays behind requireAuthenticatedApi. Observers live
// above that gate only so they can attach before protected routes finish; failed
// or unauthenticated responses never publish because their status is >= 400.
protectedSecurityRouter.use(liveUpdatesRouter);
// Confirmation is a financial write too: intercept it before the legacy
// delegation route so the balance re-check, ledger posting, transfer status,
// notifications and audit commit atomically.
protectedSecurityRouter.use(handoffConfirmationSafetyRouter);
// Stable Phase 5 attachment ids make uncertain/retried uploads exactly-once and
// resolve an offline financial clientRef after the entry reaches PostgreSQL.
protectedSecurityRouter.use(offlineAttachmentRouter);
// Corrections and voids carrying an offline precondition are write-ahead queued
// and must be checked before the legacy owner-only routes can mutate history.
protectedSecurityRouter.use(offlineRevisionRouter);
// Safe setup creations use the same durable outbox and final ids while destructive
// setup/admin operations stay authoritative-server-only. Intercept only the explicit
// offline setup marker; legacy online setup continues to fall through unchanged.
protectedSecurityRouter.use(offlineSetupRouter);
// Offline retries carrying a clientRef must reach the idempotent/conflict-safe
// routes before the legacy delegation route. Requests without an offline marker
// call next() and preserve existing production behavior unchanged.
protectedSecurityRouter.use(offlineSyncRouter);
delegationGate.use(expenseReviewRouter);
delegationGate.use(resetRouter);
delegationGate.use(operationsRouter);

await import('./index.js');

const { startAlertingIntegrityMonitor } = await import('./integrity-monitor.js');
startAlertingIntegrityMonitor();

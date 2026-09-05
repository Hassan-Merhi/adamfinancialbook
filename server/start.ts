import 'dotenv/config';
import { getConfig } from './config.js';

const config = getConfig();
console.log(JSON.stringify({
  event: 'startup.validation.ok',
  nodeEnv: config.NODE_ENV,
  node: process.version,
  port: config.PORT,
  pgssl: config.PGSSL,
  release: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? 'local',
  service: process.env.RENDER_SERVICE_NAME ?? 'adam-financial-book',
}));

// Load database code only after environment validation, so a bad deployment
// fails with one clear configuration error before opening any connections.
const { getMigrationStatus, runMigrations } = await import('./migration.js');

const applied = await runMigrations();
if (applied.length) {
  console.log(JSON.stringify({ event: 'database.migrated', applied }));
}

const status = await getMigrationStatus();
if (status.pending.length) {
  throw new Error(`Database is not ready: ${status.pending.length} migration(s) remain pending.`);
}
console.log(JSON.stringify({
  event: 'database.ready',
  currentMigration: status.current,
  latestMigration: status.latest,
}));

// Extra workflows are registered on the same router before the app mounts it,
// keeping delegated review and destructive owner-only reset logic isolated from
// the core ledger routes.
const [{ delegationGate }, { expenseReviewRouter }, { resetRouter }] = await Promise.all([
  import('./delegation.js'),
  import('./expense-review.js'),
  import('./reset.js'),
]);
delegationGate.use(expenseReviewRouter);
delegationGate.use(resetRouter);

await import('./index.js');

// A low-frequency production check independently verifies that stored effects,
// client references, handoffs, and relationship targets still agree with the
// economic meaning of every live entry. The timer is unref'd and never blocks
// shutdown or tests.
const { startIntegrityMonitor } = await import('./integrity.js');
startIntegrityMonitor();

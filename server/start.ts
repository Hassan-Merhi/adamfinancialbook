import 'dotenv/config';
import { getConfig } from './config.js';

const config = getConfig();
console.log(JSON.stringify({
  event: 'startup.validation.ok',
  nodeEnv: config.NODE_ENV,
  node: process.version,
  port: config.PORT,
  pgssl: config.PGSSL,
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

await import('./index.js');

import { pool } from './db.js';
import { getMigrationStatus, runMigrations } from './migration.js';

try {
  const applied = await runMigrations();
  const status = await getMigrationStatus();
  console.log(JSON.stringify({
    ok: status.pending.length === 0,
    applied,
    current: status.current,
    latest: status.latest,
    pending: status.pending,
  }));
  if (status.pending.length) process.exitCode = 1;
} finally {
  await pool.end();
}

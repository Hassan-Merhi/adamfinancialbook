import { pool } from './db.js';
import { getMigrationStatus } from './migration.js';

try {
  const status = await getMigrationStatus();
  const ok = status.pending.length === 0 && status.current === status.latest;
  console.log(JSON.stringify({ ok, ...status }, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  await pool.end();
}

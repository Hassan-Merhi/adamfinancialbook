import { pool } from './db.js';
import { getMigrationStatus, runMigrations } from './migration.js';

try {
  const applied = await runMigrations();
  const status = await getMigrationStatus();
  if (status.pending.length) {
    throw new Error(`Database still has pending migrations: ${status.pending.join(', ')}`);
  }
  console.log(
    applied.length
      ? `Schema is current at migration ${status.current}; applied ${applied.join(', ')}.`
      : `Schema is already current at migration ${status.current}.`,
  );
} finally {
  await pool.end();
}

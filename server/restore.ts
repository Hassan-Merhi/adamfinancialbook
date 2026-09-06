/**
 * RESTORE_DATABASE_URL=postgres://... npm run restore -- backups/file.afb
 *
 * Restores only into RESTORE_DATABASE_URL. By default it refuses to target the
 * same database as DATABASE_URL. ALLOW_PRODUCTION_RESTORE=1 is an explicit
 * emergency override and should never be left set in normal environments.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';

const path = process.argv.slice(2).find((value) => !value.startsWith('-'));
if (!path) throw new Error('Give the encrypted .afb backup file to restore.');

const sourceUrl = process.env.DATABASE_URL;
const targetUrl = process.env.RESTORE_DATABASE_URL;
if (!targetUrl) throw new Error('RESTORE_DATABASE_URL is required. Restore into a separate disposable database first.');
if (sourceUrl && targetUrl === sourceUrl && process.env.ALLOW_PRODUCTION_RESTORE !== '1') {
  throw new Error('Refusing to restore over DATABASE_URL. Use a separate RESTORE_DATABASE_URL for the restore drill.');
}

// Database modules read DATABASE_URL when imported. Point them at the restore
// target before importing any of them so source production data cannot be
// modified accidentally.
process.env.DATABASE_URL = targetUrl;

const [{ runMigrations, getMigrationStatus }, { decryptBackupBuffer, restoreBackupSnapshot }, { runIntegrityCheck }, { pool }] =
  await Promise.all([
    import('./migration.js'),
    import('./backup-service.js'),
    import('./integrity.js'),
    import('./db.js'),
  ]);

try {
  const encrypted = readFileSync(path);
  const snapshot = decryptBackupBuffer(encrypted);
  const applied = await runMigrations();
  const before = await getMigrationStatus();
  if (before.pending.length) throw new Error(`Restore target still has ${before.pending.length} pending migration(s).`);

  const restored = await restoreBackupSnapshot(snapshot);
  const integrity = await runIntegrityCheck();
  const after = await getMigrationStatus();
  if (!integrity.ok) {
    throw new Error(
      `Restore completed but integrity verification found ${integrity.errors} error(s) and ${integrity.warnings} warning(s).`,
    );
  }
  if (after.pending.length || after.current !== after.latest) {
    throw new Error('Restore target is not on the latest migration after restore verification.');
  }

  console.log(JSON.stringify({
    event: 'restore.verified',
    backupCreatedAt: snapshot.createdAt,
    backupMigrationVersion: snapshot.migrationVersion,
    appliedMigrations: applied,
    restoredTables: restored.restoredTables,
    restoredRows: restored.restoredRows,
    targetMigrationVersion: after.current,
    integrity: {
      ok: integrity.ok,
      errors: integrity.errors,
      warnings: integrity.warnings,
      checkedAt: integrity.checkedAt,
    },
  }));
} finally {
  await pool.end();
}

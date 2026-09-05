/**
 * npm run backup -- [directory]
 *
 * Creates an authenticated AES-256-GCM encrypted logical PostgreSQL snapshot.
 * BACKUP_ENCRYPTION_KEY is required. Old .afb files in the target directory are
 * pruned using BACKUP_RETENTION_DAYS (default 30).
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directoryArg = process.argv.slice(2).find((value) => !value.startsWith('-'));
const directory = directoryArg ?? process.env.BACKUP_DIRECTORY ?? 'backups';
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);
mkdirSync(directory, { recursive: true });

const [{ createEncryptedDatabaseBackup, pruneBackupFiles }, { pool }] = await Promise.all([
  import('./backup-service.js'),
  import('./db.js'),
]);

try {
  const artifact = await createEncryptedDatabaseBackup('local-archive');
  const path = join(directory, artifact.filename);
  writeFileSync(path, artifact.buffer, { mode: 0o600 });
  const pruned = pruneBackupFiles(directory, retentionDays);
  console.log(JSON.stringify({
    event: 'backup.file.written',
    path,
    id: artifact.id,
    bytes: artifact.bytes,
    checksum: artifact.checksum,
    migrationVersion: artifact.migrationVersion,
    tables: artifact.tableCount,
    rows: artifact.rowCount,
    retentionDays,
    pruned,
  }));
} finally {
  await pool.end();
}

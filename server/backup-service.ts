import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { pool, newId, query } from './db.js';
import { getMigrationStatus } from './migration.js';
import { fireOperationalAlert, logOperationalEvent } from './alerts.js';

const MAGIC = Buffer.from('AFB9');
const FORMAT_VERSION = 1;
const EXCLUDED_TABLES = new Set(['schema_migrations', 'backup_runs', 'operational_events']);

export interface BackupTable {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  checksum: string;
}

export interface DatabaseBackupSnapshot {
  format: 'adam-financial-book-postgres';
  version: 1;
  createdAt: string;
  migrationVersion: number | null;
  release: string;
  tables: BackupTable[];
}

export interface BackupArtifact {
  id: string;
  filename: string;
  buffer: Buffer;
  bytes: number;
  checksum: string;
  migrationVersion: number | null;
  tableCount: number;
  rowCount: number;
}

function quoteIdent(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function secret() {
  const value = process.env.BACKUP_ENCRYPTION_KEY;
  if (!value || value.length < 32) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be set to at least 32 characters before encrypted backups can run.');
  }
  return value;
}

async function appTables(): Promise<string[]> {
  const rows = await query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const tables = rows.map((row) => row.table_name).filter((name) => !EXCLUDED_TABLES.has(name));
  if (!tables.length) throw new Error('No application tables were found to back up.');

  const dependencies = await query<{ child: string; parent: string }>(
    `SELECT tc.table_name AS child, ccu.table_name AS parent
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.table_schema = 'public'
        AND tc.constraint_type = 'FOREIGN KEY'`,
  );
  const available = new Set(tables);
  const parents = new Map<string, Set<string>>(tables.map((table) => [table, new Set()]));
  for (const dependency of dependencies) {
    if (dependency.child === dependency.parent) continue;
    if (available.has(dependency.child) && available.has(dependency.parent)) {
      parents.get(dependency.child)!.add(dependency.parent);
    }
  }

  const ordered: string[] = [];
  const remaining = new Set(tables);
  while (remaining.size) {
    const ready = [...remaining].filter((table) =>
      [...(parents.get(table) ?? [])].every((parent) => !remaining.has(parent)));
    if (!ready.length) {
      // A database-level cycle is unusual for this schema. Preserve a stable
      // order in the artifact; restore will fail atomically rather than silently
      // accepting a partial database.
      ordered.push(...[...remaining].sort());
      break;
    }
    ready.sort();
    for (const table of ready) {
      ordered.push(table);
      remaining.delete(table);
    }
  }
  return ordered;
}

async function tableColumns(table: string) {
  const rows = await query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER'
      ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((row) => row.column_name);
}

function canonicalRows(rows: Record<string, unknown>[]) {
  return JSON.stringify(rows);
}

export async function createBackupSnapshot(): Promise<DatabaseBackupSnapshot> {
  const migration = await getMigrationStatus();
  if (migration.pending.length) {
    throw new Error(`Refusing to back up while ${migration.pending.length} migration(s) are pending.`);
  }
  const tables: BackupTable[] = [];
  for (const name of await appTables()) {
    const columns = await tableColumns(name);
    const result = await pool.query<Record<string, unknown>>(`SELECT * FROM ${quoteIdent(name)}`);
    const rows = result.rows;
    tables.push({
      name,
      columns,
      rows,
      rowCount: rows.length,
      checksum: sha256(canonicalRows(rows)),
    });
  }
  return {
    format: 'adam-financial-book-postgres',
    version: 1,
    createdAt: new Date().toISOString(),
    migrationVersion: migration.current,
    release: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? 'local',
    tables,
  };
}

export function encryptBackupSnapshot(snapshot: DatabaseBackupSnapshot): Buffer {
  const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const compressed = gzipSync(plaintext, { level: 9 });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(secret(), salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), salt, iv, tag, encrypted]);
}

export function decryptBackupBuffer(buffer: Buffer): DatabaseBackupSnapshot {
  const minimum = MAGIC.length + 1 + 16 + 12 + 16 + 1;
  if (buffer.length < minimum || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('That file is not an Adam Financial Book encrypted backup.');
  }
  const version = buffer[MAGIC.length];
  if (version !== FORMAT_VERSION) throw new Error(`Unsupported backup format version ${version}.`);
  let offset = MAGIC.length + 1;
  const salt = buffer.subarray(offset, offset + 16); offset += 16;
  const iv = buffer.subarray(offset, offset + 12); offset += 12;
  const tag = buffer.subarray(offset, offset + 16); offset += 16;
  const encrypted = buffer.subarray(offset);
  const key = scryptSync(secret(), salt, 32);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = gunzipSync(Buffer.concat([decipher.update(encrypted), decipher.final()]));
  } catch {
    throw new Error('Backup authentication failed. The key is wrong or the backup file was modified.');
  }
  const parsed = JSON.parse(plaintext.toString('utf8')) as DatabaseBackupSnapshot;
  if (parsed.format !== 'adam-financial-book-postgres' || parsed.version !== 1 || !Array.isArray(parsed.tables)) {
    throw new Error('Backup payload is not a supported Adam Financial Book database snapshot.');
  }
  for (const table of parsed.tables) {
    if (!table.name || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
      throw new Error('Backup payload contains an invalid table record.');
    }
    if (table.rowCount !== table.rows.length || table.checksum !== sha256(canonicalRows(table.rows))) {
      throw new Error(`Backup integrity check failed for table ${table.name}.`);
    }
  }
  return parsed;
}

async function markBackupStarted(id: string, destination: string) {
  await query(
    `INSERT INTO backup_runs (id, status, destination, encrypted)
     VALUES ($1,'running',$2,true)`,
    [id, destination],
  );
}

async function markBackupSuccess(id: string, artifact: Omit<BackupArtifact, 'id' | 'filename' | 'buffer'>) {
  await query(
    `UPDATE backup_runs
        SET status = 'success', completed_at = now(), bytes = $2, checksum = $3,
            migration_version = $4, error = NULL
      WHERE id = $1`,
    [id, artifact.bytes, artifact.checksum, artifact.migrationVersion],
  );
}

async function markBackupFailure(id: string, message: string) {
  await query(
    `UPDATE backup_runs
        SET status = 'failed', completed_at = now(), error = $2
      WHERE id = $1`,
    [id, message.slice(0, 1000)],
  ).catch(() => undefined);
}

export async function createEncryptedDatabaseBackup(destination = 'manual'): Promise<BackupArtifact> {
  const id = newId('bak');
  await markBackupStarted(id, destination);
  try {
    const snapshot = await createBackupSnapshot();
    const buffer = encryptBackupSnapshot(snapshot);
    const checksum = sha256(buffer);
    const artifact: BackupArtifact = {
      id,
      filename: `adam-financial-book-${snapshot.createdAt.replace(/[:.]/g, '-')}.afb`,
      buffer,
      bytes: buffer.length,
      checksum,
      migrationVersion: snapshot.migrationVersion,
      tableCount: snapshot.tables.length,
      rowCount: snapshot.tables.reduce((sum, table) => sum + table.rowCount, 0),
    };
    await markBackupSuccess(id, artifact);
    logOperationalEvent('backup.completed', {
      id,
      destination,
      bytes: artifact.bytes,
      tables: artifact.tableCount,
      rows: artifact.rowCount,
      migrationVersion: artifact.migrationVersion,
    });
    return artifact;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markBackupFailure(id, message);
    fireOperationalAlert('backup.failed', { id, destination, error: message }, 'critical', 0);
    throw error;
  }
}

export function pruneBackupFiles(directory: string, retentionDays: number) {
  if (!existsSync(directory)) return 0;
  const cutoff = Date.now() - Math.max(1, retentionDays) * 86_400_000;
  let removed = 0;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.afb')) continue;
    const path = `${directory}/${name}`;
    if (statSync(path).mtimeMs < cutoff) {
      unlinkSync(path);
      removed += 1;
    }
  }
  return removed;
}

export async function restoreBackupSnapshot(snapshot: DatabaseBackupSnapshot) {
  const migration = await getMigrationStatus();
  if (migration.pending.length) throw new Error('Restore target has pending migrations. Apply them before restoring.');
  if (snapshot.migrationVersion !== null && migration.latest !== null && snapshot.migrationVersion > migration.latest) {
    throw new Error(
      `Backup migration ${snapshot.migrationVersion} is newer than this codebase migration ${migration.latest}.`,
    );
  }
  const currentTables = new Set(await appTables());
  for (const table of snapshot.tables) {
    if (!currentTables.has(table.name)) throw new Error(`Restore target is missing table ${table.name}.`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const names = snapshot.tables.map((table) => quoteIdent(table.name));
    if (names.length) await client.query(`TRUNCATE ${names.join(', ')} RESTART IDENTITY CASCADE`);

    for (const table of snapshot.tables) {
      if (!table.rows.length) continue;
      const columns = table.columns.map(quoteIdent);
      for (const row of table.rows) {
        const values = table.columns.map((column) => row[column] ?? null);
        const placeholders = values.map((_value, index) => `$${index + 1}`);
        await client.query(
          `INSERT INTO ${quoteIdent(table.name)} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
          values,
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    restoredTables: snapshot.tables.length,
    restoredRows: snapshot.tables.reduce((sum, table) => sum + table.rows.length, 0),
    backupMigrationVersion: snapshot.migrationVersion,
    targetMigrationVersion: migration.current,
  };
}

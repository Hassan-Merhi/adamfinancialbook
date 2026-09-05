import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { loadMigrationFiles, type MigrationFile } from './migration-files.js';

interface AppliedMigrationRow {
  version: string | number;
  filename: string;
  checksum: string;
  applied_at: Date;
}

const LOCK_NAME = 'adamfinancialbook:schema-migrations';

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     BIGINT PRIMARY KEY,
      filename    TEXT NOT NULL UNIQUE,
      checksum    CHAR(64) NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function validateApplied(appliedRows: AppliedMigrationRow[], files: MigrationFile[]): void {
  const byVersion = new Map(files.map((file) => [file.version, file]));
  let maxApplied = 0;

  for (const row of appliedRows) {
    const version = Number(row.version);
    const file = byVersion.get(version);
    if (!file) {
      throw new Error(
        `Database contains migration ${version} (${row.filename}) but that migration file is missing from the codebase.`,
      );
    }
    if (file.filename !== row.filename) {
      throw new Error(
        `Migration ${version} was applied as ${row.filename} but is now named ${file.filename}. Historical migrations must not be renamed.`,
      );
    }
    if (file.checksum !== row.checksum.trim()) {
      throw new Error(
        `Migration ${file.filename} changed after it was applied. Restore the original file and create a new migration instead.`,
      );
    }
    maxApplied = Math.max(maxApplied, version);
  }

  const appliedVersions = new Set(appliedRows.map((row) => Number(row.version)));
  const outOfOrder = files.find((file) => !appliedVersions.has(file.version) && file.version < maxApplied);
  if (outOfOrder) {
    throw new Error(
      `Migration ${outOfOrder.filename} is older than an already-applied migration. Add new migrations with a higher version number.`,
    );
  }
}

export interface MigrationStatus {
  current: number | null;
  latest: number | null;
  appliedCount: number;
  pending: string[];
}

export async function runMigrations(): Promise<string[]> {
  const files = loadMigrationFiles();
  if (!files.length) throw new Error('No database migration files were found.');

  const client = await pool.connect();
  const appliedNow: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_NAME]);
    await ensureMigrationTable(client);

    const applied = (await client.query<AppliedMigrationRow>(
      'SELECT version, filename, checksum, applied_at FROM schema_migrations ORDER BY version',
    )).rows;
    validateApplied(applied, files);

    const appliedVersions = new Set(applied.map((row) => Number(row.version)));
    for (const file of files) {
      if (appliedVersions.has(file.version)) continue;

      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, filename, checksum) VALUES ($1,$2,$3)',
          [file.version, file.filename, file.checksum],
        );
        await client.query('COMMIT');
        appliedNow.push(file.filename);
        console.log(`Applied database migration ${file.filename}`);
      } catch (error) {
        await client.query('ROLLBACK');
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Database migration ${file.filename} failed and was rolled back: ${message}`);
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_NAME]);
    } finally {
      client.release();
    }
  }

  return appliedNow;
}

export async function getMigrationStatus(): Promise<MigrationStatus> {
  const files = loadMigrationFiles();
  const latest = files.at(-1)?.version ?? null;
  const exists = await pool.query<{ name: string | null }>(
    `SELECT to_regclass('public.schema_migrations')::text AS name`,
  );

  if (!exists.rows[0]?.name) {
    return {
      current: null,
      latest,
      appliedCount: 0,
      pending: files.map((file) => file.filename),
    };
  }

  const applied = (await pool.query<AppliedMigrationRow>(
    'SELECT version, filename, checksum, applied_at FROM schema_migrations ORDER BY version',
  )).rows;
  validateApplied(applied, files);

  const appliedVersions = new Set(applied.map((row) => Number(row.version)));
  return {
    current: applied.length ? Number(applied.at(-1)!.version) : null,
    latest,
    appliedCount: applied.length,
    pending: files.filter((file) => !appliedVersions.has(file.version)).map((file) => file.filename),
  };
}

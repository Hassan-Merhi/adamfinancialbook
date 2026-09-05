import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MigrationFile {
  version: number;
  versionText: string;
  filename: string;
  sql: string;
  checksum: string;
}

const here = dirname(fileURLToPath(import.meta.url));
export const defaultMigrationsDir = join(here, 'migrations');
const MIGRATION_NAME = /^(\d{3,})_([a-z0-9][a-z0-9_-]*)\.sql$/;

export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export function loadMigrationFiles(directory = defaultMigrationsDir): MigrationFile[] {
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => {
      const match = MIGRATION_NAME.exec(entry.name);
      if (!match) {
        throw new Error(`Invalid migration filename ${entry.name}. Use NNN_name.sql.`);
      }
      const versionText = match[1];
      const version = Number(versionText);
      if (!Number.isSafeInteger(version) || version <= 0) {
        throw new Error(`Invalid migration version in ${entry.name}.`);
      }
      const sql = readFileSync(join(directory, entry.name), 'utf8');
      if (!sql.trim()) throw new Error(`Migration ${entry.name} is empty.`);
      return {
        version,
        versionText,
        filename: entry.name,
        sql,
        checksum: migrationChecksum(sql),
      } satisfies MigrationFile;
    })
    .sort((a, b) => a.version - b.version || a.filename.localeCompare(b.filename));

  for (let i = 1; i < migrations.length; i += 1) {
    if (migrations[i - 1].version === migrations[i].version) {
      throw new Error(`Duplicate migration version ${migrations[i].version}.`);
    }
  }

  return migrations;
}

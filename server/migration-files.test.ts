import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrationFiles, migrationChecksum } from './migration-files.js';

const dirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'book-migrations-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('migration files', () => {
  it('loads migrations in numeric version order with stable checksums', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '010_later.sql'), 'SELECT 10;\n');
    writeFileSync(join(dir, '002_earlier.sql'), 'SELECT 2;\n');

    const files = loadMigrationFiles(dir);
    expect(files.map((file) => file.version)).toEqual([2, 10]);
    expect(files[0].checksum).toBe(migrationChecksum('SELECT 2;\n'));
  });

  it('rejects duplicate migration versions', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '001_first.sql'), 'SELECT 1;');
    writeFileSync(join(dir, '001_again.sql'), 'SELECT 2;');
    expect(() => loadMigrationFiles(dir)).toThrow(/Duplicate migration version 1/);
  });

  it('rejects malformed migration names and empty migrations', () => {
    const badName = tempDir();
    writeFileSync(join(badName, 'one.sql'), 'SELECT 1;');
    expect(() => loadMigrationFiles(badName)).toThrow(/Invalid migration filename/);

    const empty = tempDir();
    writeFileSync(join(empty, '001_empty.sql'), '   \n');
    expect(() => loadMigrationFiles(empty)).toThrow(/is empty/);
  });
});

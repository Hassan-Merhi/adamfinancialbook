/** Creates the tables. Safe to run again — every statement is IF NOT EXISTS. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, 'schema.sql'), 'utf8');

await pool.query(sql);
// Language preference was added after the original schema. Keep this migration
// idempotent so old Neon databases and brand-new installs both end up identical.
await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en'`);
console.log('Schema is in place.');
await pool.end();

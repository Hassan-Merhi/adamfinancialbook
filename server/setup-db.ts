/** Creates the tables. Safe to run again — every statement is IF NOT EXISTS. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, 'schema.sql'), 'utf8');

await pool.query(sql);
console.log('Schema is in place.');
await pool.end();

/**
 * npm run backup [directory]
 *
 * Writes the whole book to a timestamped file. Render keeps its own database
 * backups; this is the copy you can hold, read, and restore from anywhere.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from './db.js';
import { loadBook } from './book.js';
import { backup } from './export.js';

const dir = process.argv[2] ?? 'backups';
mkdirSync(dir, { recursive: true });

const book = await loadBook();
const file = join(dir, `book-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, backup(book));

console.log(`Wrote ${file} — ${book.entries.length} entries, ${book.accounts.length} accounts.`);
await pool.end();

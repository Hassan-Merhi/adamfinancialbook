import 'dotenv/config';
import { pool } from './db.js';
import { runIntegrityCheck } from './integrity.js';

try {
  const result = await runIntegrityCheck();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  await pool.end();
}

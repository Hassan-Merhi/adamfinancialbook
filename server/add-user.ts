/** npm run user:add -- someone@example.com 'their password' owner|entry */
import 'dotenv/config';
import { pool } from './db.js';
import { createUser, findUser } from './auth.js';

const [email, password, role = 'owner'] = process.argv.slice(2);

if (!email || !password) {
  console.error("Usage: npm run user:add -- email 'password' [owner|entry]");
  process.exit(1);
}
if (role !== 'owner' && role !== 'entry') {
  console.error("Role must be 'owner' or 'entry'.");
  process.exit(1);
}
if (password.length < 8) {
  console.error('Give it at least 8 characters.');
  process.exit(1);
}
if (await findUser(email)) {
  console.error(`${email} can already open the book.`);
  process.exit(1);
}

await createUser(email, password, role);
console.log(`${email} can now open the book as ${role}.`);
await pool.end();

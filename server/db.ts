import 'dotenv/config';
import { TLSSocket } from 'node:tls';
import pg from 'pg';

// NUMERIC comes back as a string by default; this book only holds money at a
// scale where a JS number is exact to the cent, so read them as numbers.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// PostgreSQL DATE has no time zone. Keep it as its canonical YYYY-MM-DD string
// instead of letting node-postgres turn it into a local-midnight Date object.
// Besides avoiding timezone date shifts, this keeps dates safe when a row is
// read and written again (for example when a delegated cash handoff is confirmed).
pg.types.setTypeParser(1082, (v) => v);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set — copy .env.example to .env and fill it in.');
}

/**
 * TLS, three ways:
 *   (default) verified — the certificate must be signed by a CA Node trusts.
 *             Neon, Supabase and Render's external addresses all pass this.
 *   no-verify — encrypted but the certificate is not checked. Only for a
 *             provider using a self-signed certificate.
 *   off       — no TLS at all. For a Postgres on your own machine.
 */
const tls = process.env.PGSSL ?? 'verify';

export const pool = new pg.Pool({
  connectionString,
  ssl: tls === 'off' ? undefined : { rejectUnauthorized: tls !== 'no-verify' },
  // A hosted database counts connections, and this book needs very few.
  max: Number(process.env.PGPOOL_MAX ?? 8),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

// A dropped connection must not take the process down with it.
pool.on('error', (err) => console.error('Database connection dropped:', err.message));

/**
 * Asking for TLS is not the same as getting it, so we look at our own socket.
 *
 * Not `pg_stat_ssl`: that is the server's view of its own backend, and behind a
 * pooler like Neon's it reads false even though the connection from here is
 * encrypted. The socket in this process is the honest answer for the hop that
 * actually crosses the internet.
 */
if (tls !== 'off') {
  const client = await pool.connect();
  const socket = (client as unknown as { connection?: { stream?: unknown } }).connection?.stream;
  client.release();

  if (socket && !(socket instanceof TLSSocket)) {
    await pool.end();
    throw new Error(
      'The database connection is not encrypted. The book will not talk to a database in the clear — '
      + 'check the connection string, or set PGSSL=off if this is a Postgres on your own machine.');
  }
  if (!socket) {
    console.warn('Could not confirm the database connection is encrypted.');
  }
}

// Schema changes do not belong in this module. server/start.ts runs the ordered,
// checksum-verified migration system before the HTTP server is imported.
export async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

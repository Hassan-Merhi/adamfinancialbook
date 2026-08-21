import 'dotenv/config';
import pg from 'pg';

// NUMERIC comes back as a string by default; this book only holds money at a
// scale where a JS number is exact to the cent, so read them as numbers.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set — copy .env.example to .env and fill it in.');
}

export const pool = new pg.Pool({
  connectionString,
  // Render's managed Postgres presents a certificate its own clients trust;
  // outside that network, allow the standard hosted-database handshake.
  ssl: process.env.PGSSL === 'off' ? undefined : { rejectUnauthorized: false },
});

export async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

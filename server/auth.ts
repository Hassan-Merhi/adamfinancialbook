/**
 * Who may open the book.
 *
 * A password is never stored, only a scrypt hash of it. A signed cookie carries
 * the session — no session table, nothing to clean up — and it is signed with
 * SESSION_SECRET, so a cookie cannot be forged or edited.
 */
import { randomBytes, createHmac, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { RequestHandler } from 'express';
import { newId, query } from './db.js';

const scrypt = promisify(scryptCb) as (secret: string, salt: Buffer, len: number) => Promise<Buffer>;

const SECRET = process.env.SESSION_SECRET ?? '';
const DAYS = 30;

export type Role = 'owner' | 'entry';
export interface User { id: string; email: string; role: Role; }

/* ---------------- passwords ---------------- */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), 64);
  const expected = Buffer.from(keyB64, 'base64');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/* ---------------- the cookie ---------------- */

export function signSession(userId: string): string {
  const expires = Date.now() + DAYS * 86_400_000;
  const body = `${userId}.${expires}`;
  return `${body}.${sign(body)}`;
}

export function readSession(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const parts = cookie.split('.');
  if (parts.length !== 3) return null;
  const [userId, expires, mac] = parts;
  const expected = sign(`${userId}.${expires}`);
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  if (Number(expires) < Date.now()) return null;
  return userId;
}

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('base64url');
}

export function cookieHeader(value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  return `book_session=${value}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/* ---------------- users ---------------- */

export async function createUser(email: string, password: string, role: Role): Promise<User> {
  const id = newId('usr');
  await query('INSERT INTO users (id, email, password_hash, role) VALUES ($1,$2,$3,$4)',
    [id, email.toLowerCase().trim(), await hashPassword(password), role]);
  return { id, email, role };
}

export async function findUser(email: string) {
  const rows = await query<{ id: string; email: string; password_hash: string; role: Role }>(
    'SELECT id, email, password_hash, role FROM users WHERE email = $1', [email.toLowerCase().trim()]);
  return rows[0] ?? null;
}

export async function userCount(): Promise<number> {
  const rows = await query<{ n: string }>('SELECT count(*)::int AS n FROM users');
  return Number(rows[0]?.n ?? 0);
}

/* ---------------- the gate ---------------- */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: User }
  }
}

const OPEN = new Set(['/health', '/login', '/first-owner', '/me']);

/**
 * Everything under /api needs a session, except signing in and asking who you
 * are. Without SESSION_SECRET set the server refuses to start, so a book can
 * never end up live with the door open.
 */
export const requireLogin: RequestHandler = async (req, res, next) => {
  if (OPEN.has(req.path)) return next();
  const userId = readSession(readCookie(req.headers.cookie, 'book_session'));
  if (!userId) return res.status(401).json({ error: 'Sign in to open the book.' });
  const rows = await query<User>('SELECT id, email, role FROM users WHERE id = $1', [userId]);
  if (!rows[0]) return res.status(401).json({ error: 'Sign in to open the book.' });
  req.user = rows[0];
  next();
};

/** Someone with entry-only access can add entries; the rest is yours. */
export const ownerOnly: RequestHandler = (req, res, next) => {
  if (req.user?.role === 'owner') return next();
  res.status(403).json({ error: 'Only you can change that — ask the owner.' });
};

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

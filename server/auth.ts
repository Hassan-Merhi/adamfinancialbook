/**
 * Who may open the book, and what they may do once inside.
 *
 * Passwords and cookies live in session.ts; this is the part that knows about
 * people.
 */
import type { RequestHandler } from 'express';
import { newId, pool, query } from './db.js';
import { checkPassword, hashPassword, readCookie, readSession } from './session.js';

export type Role = 'owner' | 'entry';
export type UserLanguage = 'en' | 'fr' | 'ar';
export interface User { id: string; email: string; role: Role; language?: UserLanguage }

export interface UserRow extends User {
  language: UserLanguage;
  passwordHash: string;
  tokenVersion: number;
  createdAt: string;
}

/* ---------------- people ---------------- */

export async function createUser(email: string, password: string, role: Role): Promise<User> {
  const id = newId('usr');
  await query('INSERT INTO users (id, email, password_hash, role) VALUES ($1,$2,$3,$4)',
    [id, tidyEmail(email), await hashPassword(password), role]);
  return { id, email: tidyEmail(email), role, language: 'en' };
}

export async function findUser(email: string): Promise<UserRow | null> {
  const rows = await query<Record<string, string | number>>(
    `SELECT id, email, password_hash, role, token_version, created_at, language
     FROM users WHERE email = $1`, [tidyEmail(email)]);
  return rows[0] ? asUser(rows[0]) : null;
}

export async function listUsers() {
  // when each of them was last let in, so a name nobody uses is easy to spot
  return query<{ id: string; email: string; role: Role; created_at: Date; last_seen: Date | null }>(
    `SELECT u.id, u.email, u.role, u.created_at,
            (SELECT max(a.at) FROM audit a WHERE a.action = 'signed in' AND a.actor = u.id) AS last_seen
     FROM users u ORDER BY u.created_at`);
}

export async function userCount(): Promise<number> {
  const rows = await query<{ n: number }>('SELECT count(*)::int AS n FROM users');
  return Number(rows[0]?.n ?? 0);
}

export async function ownerCount(): Promise<number> {
  const rows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'owner'`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Changing a password moves the token version with it, so every session opened
 * with the old password — on any phone, in any browser — stops working.
 */
export async function setPassword(userId: string, password: string): Promise<number> {
  const rows = await query<{ token_version: number }>(
    `UPDATE users SET password_hash = $2, token_version = token_version + 1
     WHERE id = $1 RETURNING token_version`, [userId, await hashPassword(password)]);
  if (!rows[0]) throw Object.assign(new Error('No such person'), { status: 404 });
  return rows[0].token_version;
}

export async function setRole(userId: string, role: Role): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET role = $2 WHERE id = $1', [userId, role]);
    // Owners already have access to the whole book. Keeping delegated rows for
    // them would silently reserve those accounts and stop another entry-only
    // user from being assigned later.
    if (role === 'owner') await client.query('DELETE FROM user_accounts WHERE user_id = $1', [userId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function removeUser(userId: string): Promise<void> {
  await query('DELETE FROM users WHERE id = $1', [userId]);
}

export async function getUser(userId: string): Promise<UserRow | null> {
  const rows = await query<Record<string, string | number>>(
    `SELECT id, email, password_hash, role, token_version, created_at, language FROM users WHERE id = $1`, [userId]);
  return rows[0] ? asUser(rows[0]) : null;
}

export async function verifyPassword(userId: string, password: string): Promise<boolean> {
  const user = await getUser(userId);
  return !!user && checkPassword(password, user.passwordHash);
}

function asUser(row: Record<string, unknown>): UserRow {
  const language = row.language === 'fr' || row.language === 'ar' ? row.language : 'en';
  return {
    id: String(row.id),
    email: String(row.email),
    role: row.role as Role,
    language,
    passwordHash: String(row.password_hash),
    tokenVersion: Number(row.token_version ?? 0),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function tidyEmail(email: string): string { return email.trim().toLowerCase(); }

/* ---------------- the gate ---------------- */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: User }
  }
}

const OPEN = new Set(['/health', '/login', '/first-owner', '/me']);

export const requireLogin: RequestHandler = async (req, res, next) => {
  // Always work out who is asking, even on the open paths: /me has to be able
  // to answer "you are still signed in" after a page reload.
  const session = readSession(readCookie(req.headers.cookie, 'book_session'));
  if (session) {
    const user = await getUser(session.userId);
    // a session from before a password change is no longer a session
    if (user && user.tokenVersion === session.version) {
      req.user = { id: user.id, email: user.email, role: user.role, language: user.language };
    }
  }

  // Keep the tiny language preference route here, beside the authenticated user
  // record. It is intentionally handled before the rest of the app so every
  // screen/user role can save the same preference without changing permissions.
  if (req.path === '/preferences/language' && req.method === 'PATCH') {
    if (!req.user) return res.status(401).json({ error: 'Sign in to open the book.' });
    if (req.get('x-book') !== '1') {
      return res.status(403).json({ error: 'Refused: that request did not come from the app.' });
    }
    const language = (req.body as { language?: unknown } | undefined)?.language;
    if (language !== 'en' && language !== 'fr' && language !== 'ar') {
      return res.status(400).json({ error: 'Choose English, French or Arabic.' });
    }
    await query('UPDATE users SET language = $2 WHERE id = $1', [req.user.id, language]);
    req.user.language = language;
    return res.json({ ok: true, language });
  }

  if (OPEN.has(req.path)) return next();
  if (!req.user) return res.status(401).json({ error: 'Sign in to open the book.' });
  next();
};

/** Someone with entry-only access can add entries; the rest is yours. */
export const ownerOnly: RequestHandler = (req, res, next) => {
  if (req.user?.role === 'owner') return next();
  res.status(403).json({ error: 'Only you can change that — ask the owner.' });
};

export { checkPassword, readCookie } from './session.js';
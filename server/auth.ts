/**
 * User identity and credential persistence.
 *
 * The legacy database column is still named `email`, but the product treats it
 * as the normalized username. HTTP/session routing lives in security-gate.ts so
 * this module remains a small database/credential boundary.
 */
import type { RequestHandler } from 'express';
import { newId, pool, query } from './db.js';
import { checkPassword, hashPassword, passwordComplaint } from './session.js';
import { usernameKey } from './username.js';

export type Role = 'owner' | 'entry';
export type UserLanguage = 'en' | 'fr' | 'ar';

export interface User {
  id: string;
  email: string;
  role: Role;
  language?: UserLanguage;
  active?: boolean;
}

export interface UserRow extends User {
  language: UserLanguage;
  passwordHash: string;
  tokenVersion: number;
  createdAt: string;
  active: boolean;
  disabledAt: string | null;
  disabledBy: string | null;
  mfaSecret: string | null;
  mfaPendingSecret: string | null;
  mfaEnabledAt: string | null;
}

function cleanUsername(value: string): string {
  const key = usernameKey(value);
  if (!key) throw Object.assign(new Error('Enter a username.'), { status: 400 });
  if (key.length > 80) throw Object.assign(new Error('Username is too long.'), { status: 400 });
  return key;
}

export async function createUser(username: string, password: string, role: Role): Promise<User> {
  const complaint = passwordComplaint(password);
  if (complaint) throw Object.assign(new Error(complaint), { status: 400 });
  const id = newId('usr');
  const login = cleanUsername(username);
  await query(
    'INSERT INTO users (id, email, password_hash, role) VALUES ($1,$2,$3,$4)',
    [id, login, await hashPassword(password), role],
  );
  return { id, email: login, role, language: 'en', active: true };
}

export async function findUser(username: string): Promise<UserRow | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, email, password_hash, role, token_version, created_at, language,
            active, disabled_at, disabled_by, mfa_secret, mfa_pending_secret, mfa_enabled_at
       FROM users WHERE email = $1`,
    [cleanUsername(username)],
  );
  return rows[0] ? asUser(rows[0]) : null;
}

export async function listUsers() {
  return query<{
    id: string;
    email: string;
    role: Role;
    active: boolean;
    created_at: Date;
    disabled_at: Date | null;
    mfa_enabled_at: Date | null;
    last_seen: Date | null;
  }>(
    `SELECT u.id, u.email, u.role, u.active, u.created_at, u.disabled_at, u.mfa_enabled_at,
            (SELECT max(s.last_seen_at) FROM user_sessions s WHERE s.user_id = u.id) AS last_seen
       FROM users u ORDER BY u.active DESC, u.created_at`,
  );
}

export async function userCount(): Promise<number> {
  const rows = await query<{ n: number }>('SELECT count(*)::int AS n FROM users');
  return Number(rows[0]?.n ?? 0);
}

export async function ownerCount(): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE role = 'owner' AND active = true`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Password changes revoke every old session immediately. */
export async function setPassword(userId: string, password: string): Promise<number> {
  const complaint = passwordComplaint(password);
  if (complaint) throw Object.assign(new Error(complaint), { status: 400 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query<{ token_version: number }>(
      `UPDATE users SET password_hash = $2, token_version = token_version + 1
        WHERE id = $1 AND active = true RETURNING token_version`,
      [userId, await hashPassword(password)],
    );
    if (!rows.rows[0]) throw Object.assign(new Error('No active person with that id.'), { status: 404 });
    await client.query(
      `UPDATE user_sessions
          SET revoked_at = COALESCE(revoked_at, now()), revoked_by = COALESCE(revoked_by, $1)
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    await client.query('COMMIT');
    return rows.rows[0].token_version;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Username changes revoke old sessions so the identity update is immediate. */
export async function setUsername(
  userId: string,
  username: string,
): Promise<{ username: string; tokenVersion: number }> {
  const login = cleanUsername(username);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query<{ email: string; token_version: number }>(
      `UPDATE users SET email = $2, token_version = token_version + 1
        WHERE id = $1 AND active = true RETURNING email, token_version`,
      [userId, login],
    );
    if (!rows.rows[0]) throw Object.assign(new Error('No active person with that id.'), { status: 404 });
    await client.query(
      `UPDATE user_sessions
          SET revoked_at = COALESCE(revoked_at, now()), revoked_by = COALESCE(revoked_by, $1)
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    await client.query('COMMIT');
    return { username: rows.rows[0].email, tokenVersion: rows.rows[0].token_version };
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      throw Object.assign(new Error('That username is already in use.'), { status: 409 });
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Role changes revoke old sessions so privileges change immediately. */
export async function setRole(userId: string, role: Role): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query<{ token_version: number }>(
      `UPDATE users SET role = $2, token_version = token_version + 1
        WHERE id = $1 AND active = true RETURNING token_version`,
      [userId, role],
    );
    if (!rows.rows[0]) throw Object.assign(new Error('No active person with that id.'), { status: 404 });
    if (role === 'owner') await client.query('DELETE FROM user_accounts WHERE user_id = $1', [userId]);
    await client.query(
      `UPDATE user_sessions
          SET revoked_at = COALESCE(revoked_at, now()), revoked_by = COALESCE(revoked_by, $1)
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    await client.query('COMMIT');
    return rows.rows[0].token_version;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function disableUser(userId: string, disabledBy: string | null): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query(
      `UPDATE users
          SET active = false, disabled_at = now(), disabled_by = $2, token_version = token_version + 1
        WHERE id = $1 AND active = true RETURNING id`,
      [userId, disabledBy],
    );
    if (!rows.rows[0]) throw Object.assign(new Error('No active person with that id.'), { status: 404 });
    await client.query('DELETE FROM user_accounts WHERE user_id = $1', [userId]);
    await client.query(
      `UPDATE pending_transfers SET status = 'rejected', confirmed_at = COALESCE(confirmed_at, now())
        WHERE recipient_user_id = $1 AND status = 'pending'`,
      [userId],
    );
    await client.query(
      `UPDATE user_sessions
          SET revoked_at = COALESCE(revoked_at, now()), revoked_by = COALESCE(revoked_by, $2)
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, disabledBy],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function restoreUser(userId: string): Promise<void> {
  const rows = await query(
    `UPDATE users
        SET active = true, disabled_at = NULL, disabled_by = NULL, token_version = token_version + 1
      WHERE id = $1 AND active = false RETURNING id`,
    [userId],
  );
  if (!rows[0]) throw Object.assign(new Error('No disabled person with that id.'), { status: 404 });
}

/** Legacy call sites now soft-disable instead of deleting a historical principal. */
export async function removeUser(userId: string): Promise<void> {
  await disableUser(userId, null);
}

export async function getUser(userId: string): Promise<UserRow | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, email, password_hash, role, token_version, created_at, language,
            active, disabled_at, disabled_by, mfa_secret, mfa_pending_secret, mfa_enabled_at
       FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0] ? asUser(rows[0]) : null;
}

export async function verifyPassword(userId: string, password: string): Promise<boolean> {
  const user = await getUser(userId);
  return !!user && user.active && checkPassword(password, user.passwordHash);
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
    active: row.active !== false,
    disabledAt: row.disabled_at ? new Date(row.disabled_at as string).toISOString() : null,
    disabledBy: row.disabled_by ? String(row.disabled_by) : null,
    mfaSecret: row.mfa_secret ? String(row.mfa_secret) : null,
    mfaPendingSecret: row.mfa_pending_secret ? String(row.mfa_pending_secret) : null,
    mfaEnabledAt: row.mfa_enabled_at ? new Date(row.mfa_enabled_at as string).toISOString() : null,
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      securitySession?: { id: string; authenticatedAt: string; expiresAt: string };
    }
  }
}

export const ownerOnly: RequestHandler = (req, res, next) => {
  if (req.user?.role === 'owner') return next();
  res.status(403).json({ error: 'Only you can change that — ask the owner.' });
};

export { checkPassword, readCookie } from './session.js';
export { usernameKey } from './username.js';

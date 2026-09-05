/**
 * Who may open the book, and what they may do once inside.
 *
 * The legacy database column is still named `email`, but the product treats it
 * as the normalized username. Phase 6 adds durable sessions, persistent login
 * throttling, soft-disable, recent-auth checks and optional owner TOTP MFA.
 */
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { newId, pool, query } from './db.js';
import { record } from './audit.js';
import {
  checkPassword,
  cookieHeader,
  hashPassword,
  passwordComplaint,
  readCookie,
  readSession,
  signSession,
  suggestPassword,
} from './session.js';
import {
  RECENT_AUTH_SECONDS,
  cleanupSecurityRows,
  clearLoginFailures,
  createSecuritySession,
  decryptMfaSecret,
  encryptMfaSecret,
  generateTotpSecret,
  hasRecentAuthentication,
  listSecuritySessions,
  loginThrottleStatus,
  markSessionReauthenticated,
  noteLoginFailure,
  revokeSecuritySession,
  revokeUserSessions,
  totpUri,
  validateSecuritySession,
  verifyTotp,
} from './security.js';
import { runWithRequestActor } from './request-context.js';
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

/* ---------------- people ---------------- */

export async function createUser(username: string, password: string, role: Role): Promise<User> {
  const complaint = passwordComplaint(password);
  if (complaint) throw Object.assign(new Error(complaint), { status: 400 });
  const id = newId('usr');
  const login = cleanUsername(username);
  await query('INSERT INTO users (id, email, password_hash, role) VALUES ($1,$2,$3,$4)',
    [id, login, await hashPassword(password), role]);
  return { id, email: login, role, language: 'en', active: true };
}

export async function findUser(username: string): Promise<UserRow | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, email, password_hash, role, token_version, created_at, language,
            active, disabled_at, disabled_by, mfa_secret, mfa_pending_secret, mfa_enabled_at
       FROM users WHERE email = $1`, [cleanUsername(username)]);
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
       FROM users u ORDER BY u.active DESC, u.created_at`);
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
      `UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()), revoked_by = COALESCE(revoked_by, $1)
        WHERE user_id = $1 AND revoked_at IS NULL`, [userId],
    );
    await client.query('COMMIT');
    return rows.rows[0].token_version;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

/** Username changes revoke old sessions so the identity update is immediate. */
export async function setUsername(userId: string, username: string): Promise<{ username: string; tokenVersion: number }> {
  const login = cleanUsername(username);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query<{ email: string; token_version: number }>(
      `UPDATE users SET email = $2, token_version = token_version + 1
        WHERE id = $1 AND active = true RETURNING email, token_version`, [userId, login]);
    if (!rows.rows[0]) throw Object.assign(new Error('No active person with that id.'), { status: 404 });
    await client.query(
      `UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()), revoked_by = COALESCE(revoked_by, $1)
        WHERE user_id = $1 AND revoked_at IS NULL`, [userId],
    );
    await client.query('COMMIT');
    return { username: rows.rows[0].email, tokenVersion: rows.rows[0].token_version };
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') throw Object.assign(new Error('That username is already in use.'), { status: 409 });
    throw error;
  } finally { client.release(); }
}

/** Role changes revoke old sessions so privileges change immediately. */
export async function setRole(userId: string, role: Role): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query<{ token_version: number }>(
      `UPDATE users SET role = $2, token_version = token_version + 1
        WHERE id = $1 AND active = true RETURNING token_version`, [userId, role]);
    if (!rows.rows[0]) throw Object.assign(new Error('No active person with that id.'), { status: 404 });
    if (role === 'owner') await client.query('DELETE FROM user_accounts WHERE user_id = $1', [userId]);
    await client.query(
      `UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()), revoked_by = COALESCE(revoked_by, $1)
        WHERE user_id = $1 AND revoked_at IS NULL`, [userId],
    );
    await client.query('COMMIT');
    return rows.rows[0].token_version;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function disableUser(userId: string, disabledBy: string | null): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query(
      `UPDATE users
          SET active = false, disabled_at = now(), disabled_by = $2, token_version = token_version + 1
        WHERE id = $1 AND active = true RETURNING id`, [userId, disabledBy]);
    if (!rows.rows[0]) throw Object.assign(new Error('No active person with that id.'), { status: 404 });
    await client.query('DELETE FROM user_accounts WHERE user_id = $1', [userId]);
    await client.query(
      `UPDATE pending_transfers SET status = 'rejected', confirmed_at = COALESCE(confirmed_at, now())
        WHERE recipient_user_id = $1 AND status = 'pending'`, [userId]);
    await client.query(
      `UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()), revoked_by = COALESCE(revoked_by, $2)
        WHERE user_id = $1 AND revoked_at IS NULL`, [userId, disabledBy]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function restoreUser(userId: string): Promise<void> {
  const rows = await query(
    `UPDATE users
        SET active = true, disabled_at = NULL, disabled_by = NULL, token_version = token_version + 1
      WHERE id = $1 AND active = false RETURNING id`, [userId]);
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
       FROM users WHERE id = $1`, [userId]);
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

/* ---------------- the gate ---------------- */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      securitySession?: { id: string; authenticatedAt: string; expiresAt: string };
    }
  }
}

const OPEN = new Set(['/health', '/login', '/first-owner', '/me']);
const usernameFields = { username: z.string().optional(), email: z.string().optional() };

function writeAllowed(req: Request): boolean { return req.get('x-book') === '1'; }
function requestMeta(req: Request) { return { ip: req.ip, userAgent: req.get('user-agent') ?? '' }; }

async function setTrackedCookie(req: Request, res: Response, user: UserRow, tokenVersion = user.tokenVersion) {
  const created = await createSecuritySession({ userId: user.id, tokenVersion, role: user.role, ...requestMeta(req) });
  res.setHeader('Set-Cookie', cookieHeader(
    signSession(user.id, tokenVersion, created.id, created.expiresAt.getTime()), created.maxAgeSeconds,
  ));
  req.securitySession = {
    id: created.id,
    authenticatedAt: new Date().toISOString(),
    expiresAt: created.expiresAt.toISOString(),
  };
  return created;
}

async function notifyActiveOwners(title: string, body: string): Promise<void> {
  const owners = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'owner' AND active = true`);
  for (const owner of owners) {
    await query(
      `INSERT INTO notifications (id, user_id, type, title, body)
       VALUES ($1,$2,'security_event',$3,$4)`, [newId('ntf'), owner.id, title, body]);
  }
}

async function requireOwner(req: Request, res: Response): Promise<boolean> {
  if (req.user?.role === 'owner') return true;
  res.status(403).json({ error: 'Only an owner can change security access.' });
  return false;
}

async function requireRecent(req: Request, res: Response): Promise<boolean> {
  if (await hasRecentAuthentication(req.securitySession?.id)) return true;
  res.status(403).json({ error: 'Unlock security changes with your current password first.', code: 'reauth_required' });
  return false;
}

function currentUserJson(user: UserRow | User) {
  return { id: user.id, email: user.email, role: user.role, language: user.language ?? 'en' };
}

async function loginFailure(req: Request, res: Response, username: string, code?: string) {
  const login = usernameKey(username);
  const state = await noteLoginFailure(req.ip, login);
  await record(req, state.justLocked ? 'sign-in locked' : 'sign-in refused', login, { ip: req.ip });
  if (state.justLocked) {
    await notifyActiveOwners('Repeated sign-in failures', `Sign-in attempts for ${login || 'a username'} were locked for 15 minutes.`);
  }
  if (state.locked) {
    res.setHeader('Retry-After', String(state.retryAfterSeconds));
    res.status(429).json({ error: 'Too many tries. Wait fifteen minutes and try again.', code: 'login_locked' });
  } else {
    res.status(401).json({
      error: code === 'mfa_invalid' ? 'That authenticator code is not valid.' : 'That username and password do not match.',
      code,
    });
  }
}

async function handleSecurityRoute(req: Request, res: Response): Promise<boolean> {
  if (req.path === '/login' && req.method === 'POST') {
    const body = z.object({ ...usernameFields, password: z.string().max(200), totp: z.string().max(20).optional() })
      .refine((value) => !!(value.username ?? value.email)?.trim(), { message: 'Enter a username.' }).parse(req.body);
    const username = body.username ?? body.email ?? '';
    const login = usernameKey(username);
    const throttle = await loginThrottleStatus(req.ip, login);
    if (throttle.locked) {
      res.setHeader('Retry-After', String(throttle.retryAfterSeconds));
      res.status(429).json({ error: 'Too many tries. Wait fifteen minutes and try again.', code: 'login_locked' });
      return true;
    }
    const user = await findUser(username);
    if (!user || !user.active || !(await checkPassword(body.password, user.passwordHash))) {
      await loginFailure(req, res, username);
      return true;
    }
    if (user.mfaEnabledAt && user.mfaSecret) {
      if (!body.totp) {
        res.status(401).json({ error: 'Enter the 6-digit code from your authenticator.', code: 'mfa_required' });
        return true;
      }
      if (!verifyTotp(decryptMfaSecret(user.mfaSecret), body.totp)) {
        await loginFailure(req, res, username, 'mfa_invalid');
        return true;
      }
    }
    await clearLoginFailures(req.ip, login);
    await setTrackedCookie(req, res, user);
    req.user = currentUserJson(user);
    await record(req, 'signed in', user.email, { sessionId: req.securitySession?.id });
    await cleanupSecurityRows().catch((error) => console.warn('Security cleanup failed:', (error as Error).message));
    res.json({ user: currentUserJson(user), needsFirstOwner: false });
    return true;
  }

  if (req.path === '/first-owner' && req.method === 'POST') {
    if ((await userCount()) > 0) { res.status(403).json({ error: 'The book already has an owner.' }); return true; }
    const body = z.object({ ...usernameFields, password: z.string().max(200) })
      .refine((value) => !!(value.username ?? value.email)?.trim(), { message: 'Enter a username.' }).parse(req.body);
    const username = body.username ?? body.email ?? '';
    const complaint = passwordComplaint(body.password);
    if (complaint) { res.status(400).json({ error: complaint }); return true; }
    const created = await createUser(username, body.password, 'owner');
    const user = await getUser(created.id);
    if (!user) throw new Error('Could not read the owner after creating it.');
    await setTrackedCookie(req, res, user);
    req.user = currentUserJson(user);
    await record(req, 'book opened', user.email, { sessionId: req.securitySession?.id });
    res.status(201).json({ user: currentUserJson(user), needsFirstOwner: false });
    return true;
  }

  if (req.path === '/logout' && req.method === 'POST') {
    if (!writeAllowed(req)) { res.status(403).json({ error: 'Refused: that request did not come from the app.' }); return true; }
    if (req.user && req.securitySession?.id) {
      await revokeSecuritySession(req.user.id, req.securitySession.id, req.user.id);
      await record(req, 'signed out', req.user.id, { sessionId: req.securitySession.id });
    }
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    res.json({ ok: true });
    return true;
  }

  if (req.path === '/users' && req.method === 'GET') {
    if (!(await requireOwner(req, res))) return true;
    const rows = await listUsers();
    res.json({
      users: rows.map((u) => ({
        id: u.id, email: u.email, role: u.role, active: u.active,
        createdAt: new Date(u.created_at).toISOString(),
        disabledAt: u.disabled_at ? new Date(u.disabled_at).toISOString() : null,
        mfaEnabled: !!u.mfa_enabled_at,
        lastSeen: u.last_seen ? new Date(u.last_seen).toISOString() : null,
      })),
      suggestion: suggestPassword(),
    });
    return true;
  }

  if (req.path === '/users' && req.method === 'POST') {
    if (!writeAllowed(req) || !(await requireOwner(req, res)) || !(await requireRecent(req, res))) return true;
    const body = z.object({ ...usernameFields, password: z.string().max(200), role: z.enum(['owner', 'entry']) })
      .refine((value) => !!(value.username ?? value.email)?.trim(), { message: 'Enter a username.' }).parse(req.body);
    const username = body.username ?? body.email ?? '';
    const complaint = passwordComplaint(body.password);
    if (complaint) { res.status(400).json({ error: complaint }); return true; }
    if (await findUser(username)) {
      res.status(409).json({ error: 'That username already belongs to an existing or disabled user. Restore that user instead.' });
      return true;
    }
    const user = await createUser(username, body.password, body.role);
    await record(req, 'person given access', user.id, { username: user.email, role: user.role });
    res.status(201).json({ user });
    return true;
  }

  const usernameChange = req.path.match(/^\/users\/([^/]+)\/username$/);
  if (usernameChange && req.method === 'POST') {
    if (!writeAllowed(req) || !(await requireOwner(req, res)) || !(await requireRecent(req, res))) return true;
    const target = await getUser(usernameChange[1]);
    if (!target || !target.active) { res.status(404).json({ error: 'No active person with that id.' }); return true; }
    const { username } = z.object({ username: z.string().min(1).max(100) }).parse(req.body);
    const changed = await setUsername(target.id, username);
    await record(req, 'username changed', target.id, { from: target.email, to: changed.username });
    if (target.id === req.user!.id) {
      const fresh = await getUser(target.id);
      if (!fresh) throw new Error('Could not refresh current user.');
      req.user = currentUserJson(fresh);
      await setTrackedCookie(req, res, fresh, changed.tokenVersion);
    }
    res.json({ ok: true, username: changed.username });
    return true;
  }

  const passwordReset = req.path.match(/^\/users\/([^/]+)\/password$/);
  if (passwordReset && req.method === 'POST') {
    if (!writeAllowed(req) || !(await requireOwner(req, res)) || !(await requireRecent(req, res))) return true;
    const target = await getUser(passwordReset[1]);
    if (!target || !target.active) { res.status(404).json({ error: 'No active person with that id.' }); return true; }
    const { password } = z.object({ password: z.string().max(200) }).parse(req.body);
    const version = await setPassword(target.id, password);
    await record(req, 'password reset', target.id, { username: target.email });
    if (target.id === req.user!.id) {
      const fresh = await getUser(target.id);
      if (!fresh) throw new Error('Could not refresh current user.');
      await setTrackedCookie(req, res, fresh, version);
    }
    res.json({ ok: true });
    return true;
  }

  const roleChange = req.path.match(/^\/users\/([^/]+)\/role$/);
  if (roleChange && req.method === 'POST') {
    if (!writeAllowed(req) || !(await requireOwner(req, res)) || !(await requireRecent(req, res))) return true;
    const target = await getUser(roleChange[1]);
    if (!target || !target.active) { res.status(404).json({ error: 'No active person with that id.' }); return true; }
    const { role } = z.object({ role: z.enum(['owner', 'entry']) }).parse(req.body);
    if (target.role === 'owner' && role !== 'owner' && (await ownerCount()) === 1) {
      res.status(400).json({ error: 'This is the only active owner — make someone else an owner first.' }); return true;
    }
    const version = await setRole(target.id, role);
    await record(req, 'role changed', target.id, { username: target.email, role });
    if (target.id === req.user!.id) {
      const fresh = await getUser(target.id);
      if (!fresh) throw new Error('Could not refresh current user.');
      req.user = currentUserJson(fresh);
      await setTrackedCookie(req, res, fresh, version);
    }
    res.json({ ok: true });
    return true;
  }

  const restore = req.path.match(/^\/users\/([^/]+)\/restore$/);
  if (restore && req.method === 'POST') {
    if (!writeAllowed(req) || !(await requireOwner(req, res)) || !(await requireRecent(req, res))) return true;
    const target = await getUser(restore[1]);
    if (!target) { res.status(404).json({ error: 'No such historical user.' }); return true; }
    if (target.active) { res.status(409).json({ error: 'That user already has access.' }); return true; }
    await restoreUser(target.id);
    await record(req, 'access restored', target.id, { username: target.email, role: target.role });
    await notifyActiveOwners('Access restored', `${target.email} can open the book again.`);
    res.json({ ok: true });
    return true;
  }

  const disable = req.path.match(/^\/users\/([^/]+)$/);
  if (disable && req.method === 'DELETE') {
    if (!writeAllowed(req) || !(await requireOwner(req, res)) || !(await requireRecent(req, res))) return true;
    const target = await getUser(disable[1]);
    if (!target || !target.active) { res.status(404).json({ error: 'No active person with that id.' }); return true; }
    if (target.id === req.user!.id) { res.status(400).json({ error: 'You cannot disable your own access.' }); return true; }
    if (target.role === 'owner' && (await ownerCount()) === 1) {
      res.status(400).json({ error: 'This is the only active owner.' }); return true;
    }
    await disableUser(target.id, req.user!.id);
    await record(req, 'access disabled', target.id, { username: target.email, role: target.role });
    await notifyActiveOwners('Access disabled', `${target.email} was disabled and all of their sessions were revoked.`);
    res.json({ ok: true });
    return true;
  }

  if (req.path === '/password' && req.method === 'POST') {
    if (!writeAllowed(req)) { res.status(403).json({ error: 'Refused: that request did not come from the app.' }); return true; }
    if (!req.user) { res.status(401).json({ error: 'Sign in to open the book.' }); return true; }
    const { current, next } = z.object({ current: z.string().max(200), next: z.string().max(200) }).parse(req.body);
    const complaint = passwordComplaint(next);
    if (complaint) { res.status(400).json({ error: complaint }); return true; }
    if (!(await verifyPassword(req.user.id, current))) {
      res.status(401).json({ error: 'That is not your current password.' }); return true;
    }
    const version = await setPassword(req.user.id, next);
    const fresh = await getUser(req.user.id);
    if (!fresh) throw new Error('Could not refresh current user.');
    await setTrackedCookie(req, res, fresh, version);
    await record(req, 'password changed', req.user.id, { username: req.user.email });
    res.json({ ok: true });
    return true;
  }

  if (req.path === '/security' && req.method === 'GET') {
    if (!req.user) { res.status(401).json({ error: 'Sign in to open the book.' }); return true; }
    const user = await getUser(req.user.id);
    if (!user) { res.status(401).json({ error: 'Sign in to open the book.' }); return true; }
    const recent = await hasRecentAuthentication(req.securitySession?.id);
    const authenticatedAt = req.securitySession?.authenticatedAt ? new Date(req.securitySession.authenticatedAt).getTime() : 0;
    res.json({
      mfaEnabled: !!user.mfaEnabledAt,
      recentlyAuthenticated: recent,
      recentAuthExpiresAt: authenticatedAt ? new Date(authenticatedAt + RECENT_AUTH_SECONDS * 1000).toISOString() : null,
      sessions: await listSecuritySessions(user.id, req.securitySession?.id),
    });
    return true;
  }

  if (req.path === '/security/reauth' && req.method === 'POST') {
    if (!writeAllowed(req) || !req.user || !req.securitySession?.id) {
      res.status(401).json({ error: 'Sign in again to change security settings.' }); return true;
    }
    const body = z.object({ password: z.string().max(200), totp: z.string().max(20).optional() }).parse(req.body);
    const user = await getUser(req.user.id);
    if (!user || !user.active || !(await checkPassword(body.password, user.passwordHash))) {
      await record(req, 'security reauthentication refused', req.user.id);
      res.status(401).json({ error: 'That is not your current password.' }); return true;
    }
    if (user.mfaEnabledAt && user.mfaSecret) {
      if (!body.totp) { res.status(401).json({ error: 'Enter your authenticator code too.', code: 'mfa_required' }); return true; }
      if (!verifyTotp(decryptMfaSecret(user.mfaSecret), body.totp)) {
        await record(req, 'security reauthentication refused', req.user.id, { reason: 'mfa' });
        res.status(401).json({ error: 'That authenticator code is not valid.', code: 'mfa_invalid' }); return true;
      }
    }
    await markSessionReauthenticated(req.securitySession.id);
    req.securitySession.authenticatedAt = new Date().toISOString();
    await record(req, 'security reauthenticated', req.user.id, { sessionId: req.securitySession.id });
    res.json({ ok: true, recentAuthSeconds: RECENT_AUTH_SECONDS });
    return true;
  }

  if (req.path === '/security/mfa/setup' && req.method === 'POST') {
    if (!writeAllowed(req) || !(await requireOwner(req, res)) || !(await requireRecent(req, res))) return true;
    const user = await getUser(req.user!.id);
    if (!user) throw Object.assign(new Error('No such person.'), { status: 404 });
    if (user.mfaEnabledAt) { res.status(409).json({ error: 'Authenticator MFA is already enabled.' }); return true; }
    const secret = generateTotpSecret();
    await query('UPDATE users SET mfa_pending_secret = $2 WHERE id = $1', [user.id, encryptMfaSecret(secret)]);
    await record(req, 'mfa setup started', user.id);
    res.json({ secret, uri: totpUri(user.email, secret) });
    return true;
  }

  if (req.path === '/security/mfa/enable' && req.method === 'POST') {
    if (!writeAllowed(req) || !(await requireOwner(req, res)) || !(await requireRecent(req, res))) return true;
    const { code } = z.object({ code: z.string().max(20) }).parse(req.body);
    const user = await getUser(req.user!.id);
    if (!user?.mfaPendingSecret) { res.status(409).json({ error: 'Start authenticator setup first.' }); return true; }
    const secret = decryptMfaSecret(user.mfaPendingSecret);
    if (!verifyTotp(secret, code)) { res.status(400).json({ error: 'That authenticator code is not valid.' }); return true; }
    await query(`UPDATE users SET mfa_secret = mfa_pending_secret, mfa_pending_secret = NULL, mfa_enabled_at = now() WHERE id = $1`, [user.id]);
    await revokeUserSessions(user.id, user.id, req.securitySession?.id);
    await record(req, 'mfa enabled', user.id, { sessionId: req.securitySession?.id });
    await notifyActiveOwners('Authenticator enabled', `${user.email} enabled authenticator MFA.`);
    res.json({ ok: true });
    return true;
  }

  if (req.path === '/security/mfa/disable' && req.method === 'POST') {
    if (!writeAllowed(req) || !(await requireOwner(req, res)) || !(await requireRecent(req, res))) return true;
    const { code } = z.object({ code: z.string().max(20) }).parse(req.body);
    const user = await getUser(req.user!.id);
    if (!user?.mfaEnabledAt || !user.mfaSecret) { res.status(409).json({ error: 'Authenticator MFA is not enabled.' }); return true; }
    if (!verifyTotp(decryptMfaSecret(user.mfaSecret), code)) { res.status(400).json({ error: 'That authenticator code is not valid.' }); return true; }
    await query(`UPDATE users SET mfa_secret = NULL, mfa_pending_secret = NULL, mfa_enabled_at = NULL WHERE id = $1`, [user.id]);
    await revokeUserSessions(user.id, user.id, req.securitySession?.id);
    await record(req, 'mfa disabled', user.id, { sessionId: req.securitySession?.id });
    await notifyActiveOwners('Authenticator disabled', `${user.email} disabled authenticator MFA.`);
    res.json({ ok: true });
    return true;
  }

  const revokeOne = req.path.match(/^\/security\/sessions\/([^/]+)$/);
  if (revokeOne && req.method === 'DELETE') {
    if (!writeAllowed(req) || !req.user) { res.status(401).json({ error: 'Sign in to manage sessions.' }); return true; }
    const targetId = revokeOne[1];
    const revoked = await revokeSecuritySession(req.user.id, targetId, req.user.id);
    if (!revoked) { res.status(404).json({ error: 'No active session with that id.' }); return true; }
    await record(req, 'security session revoked', req.user.id, { sessionId: targetId });
    if (targetId === req.securitySession?.id) res.setHeader('Set-Cookie', cookieHeader('', 0));
    res.json({ ok: true, signedOut: targetId === req.securitySession?.id });
    return true;
  }

  if (req.path === '/security/sessions/revoke-all' && req.method === 'POST') {
    if (!writeAllowed(req) || !req.user || !(await requireRecent(req, res))) return true;
    const count = await revokeUserSessions(req.user.id, req.user.id);
    await record(req, 'all security sessions revoked', req.user.id, { count });
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    res.json({ ok: true, count, signedOut: true });
    return true;
  }

  return false;
}

export const requireLogin: RequestHandler = async (req, res, next) => {
  const parsed = readSession(readCookie(req.headers.cookie, 'book_session'));
  if (parsed) {
    const user = await getUser(parsed.userId);
    if (user?.active && user.tokenVersion === parsed.version) {
      if (parsed.sessionId) {
        const tracked = await validateSecuritySession(parsed.sessionId, user.id, user.tokenVersion);
        if (tracked) {
          req.user = currentUserJson(user);
          req.securitySession = {
            id: tracked.id,
            authenticatedAt: tracked.authenticatedAt.toISOString(),
            expiresAt: tracked.expiresAt.toISOString(),
          };
        }
      } else {
        // Upgrade pre-Phase-6 signed cookies once so rollout does not force a logout.
        await setTrackedCookie(req, res, user);
        req.user = currentUserJson(user);
      }
    }
  }

  if (await handleSecurityRoute(req, res)) return;

  if (req.path === '/preferences/language' && req.method === 'PATCH') {
    if (!req.user) return res.status(401).json({ error: 'Sign in to open the book.' });
    if (!writeAllowed(req)) return res.status(403).json({ error: 'Refused: that request did not come from the app.' });
    const language = (req.body as { language?: unknown } | undefined)?.language;
    if (language !== 'en' && language !== 'fr' && language !== 'ar') {
      return res.status(400).json({ error: 'Choose English, French or Arabic.' });
    }
    await query('UPDATE users SET language = $2 WHERE id = $1 AND active = true', [req.user.id, language]);
    req.user.language = language;
    return res.json({ ok: true, language });
  }

  if (!OPEN.has(req.path) && !req.user) return res.status(401).json({ error: 'Sign in to open the book.' });

  if (
    req.method === 'PUT'
    && /^\/delegation\/users\/[^/]+\/accounts$/.test(req.path)
    && !(await hasRecentAuthentication(req.securitySession?.id))
  ) {
    return res.status(403).json({ error: 'Unlock security changes with your current password first.', code: 'reauth_required' });
  }

  return runWithRequestActor(req.user ? { id: req.user.id, email: req.user.email } : null, () => next());
};

export const ownerOnly: RequestHandler = (req, res, next) => {
  if (req.user?.role === 'owner') return next();
  res.status(403).json({ error: 'Only you can change that — ask the owner.' });
};

export { checkPassword, readCookie } from './session.js';
export { usernameKey } from './username.js';

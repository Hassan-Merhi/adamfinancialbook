import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { newId, query } from './db.js';
import { record } from './audit.js';
import {
  createUser,
  disableUser,
  findUser,
  getUser,
  listUsers,
  ownerCount,
  restoreUser,
  setPassword,
  setRole,
  setUsername,
  userCount,
  usernameKey,
  type User,
  type UserRow,
} from './auth.js';
import {
  checkPassword,
  cookieHeader,
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

const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const usernameFields = { username: z.string().optional(), email: z.string().optional() };

function currentUserJson(user: UserRow | User) {
  return { id: user.id, email: user.email, role: user.role, language: user.language ?? 'en' };
}

function requestMeta(req: Request) {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? '' };
}

async function setTrackedCookie(req: Request, res: Response, user: UserRow, tokenVersion = user.tokenVersion) {
  const created = await createSecuritySession({
    userId: user.id,
    tokenVersion,
    role: user.role,
    ...requestMeta(req),
  });
  res.setHeader('Set-Cookie', cookieHeader(
    signSession(user.id, tokenVersion, created.id, created.expiresAt.getTime()),
    created.maxAgeSeconds,
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
       VALUES ($1,$2,'security_event',$3,$4)`,
      [newId('ntf'), owner.id, title, body],
    );
  }
}

async function loginFailure(req: Request, res: Response, username: string, code?: string) {
  const login = usernameKey(username);
  const state = await noteLoginFailure(req.ip, login);
  await record(req, state.justLocked ? 'sign-in locked' : 'sign-in refused', login, { ip: req.ip });
  if (state.justLocked) {
    await notifyActiveOwners(
      'Repeated sign-in failures',
      `Sign-in attempts for ${login || 'a username'} were locked for 15 minutes.`,
    );
  }
  if (state.locked) {
    res.setHeader('Retry-After', String(state.retryAfterSeconds));
    res.status(429).json({ error: 'Too many tries. Wait fifteen minutes and try again.', code: 'login_locked' });
    return;
  }
  res.status(401).json({
    error: code === 'mfa_invalid'
      ? 'That authenticator code is not valid.'
      : 'That username and password do not match.',
    code,
  });
}

export const loadSecuritySession: RequestHandler = wrap(async (req, res, next) => {
  const parsed = readSession(readCookie(req.headers.cookie, 'book_session'));
  if (!parsed) return next();

  const user = await getUser(parsed.userId);
  if (!user?.active || user.tokenVersion !== parsed.version) return next();

  if (parsed.sessionId) {
    const tracked = await validateSecuritySession(parsed.sessionId, user.id, user.tokenVersion);
    if (!tracked) return next();
    req.user = currentUserJson(user);
    req.securitySession = {
      id: tracked.id,
      authenticatedAt: tracked.authenticatedAt.toISOString(),
      expiresAt: tracked.expiresAt.toISOString(),
    };
    return next();
  }

  // Upgrade a valid pre-Phase-6 signed cookie once, avoiding a forced logout.
  await setTrackedCookie(req, res, user);
  req.user = currentUserJson(user);
  return next();
});

export const publicSecurityRouter = Router();

publicSecurityRouter.get('/health', wrap(async (_req, res) => {
  await query('SELECT 1');
  res.json({ ok: true });
}));

publicSecurityRouter.get('/me', wrap(async (req, res) => {
  res.json({ user: req.user ?? null, needsFirstOwner: (await userCount()) === 0 });
}));

publicSecurityRouter.post('/login', wrap(async (req, res) => {
  const body = z.object({
    ...usernameFields,
    password: z.string().max(200),
    totp: z.string().max(20).optional(),
  }).refine((value) => !!(value.username ?? value.email)?.trim(), { message: 'Enter a username.' }).parse(req.body);
  const username = body.username ?? body.email ?? '';
  const login = usernameKey(username);
  const throttle = await loginThrottleStatus(req.ip, login);
  if (throttle.locked) {
    res.setHeader('Retry-After', String(throttle.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many tries. Wait fifteen minutes and try again.', code: 'login_locked' });
  }

  const user = await findUser(username);
  if (!user || !user.active || !(await checkPassword(body.password, user.passwordHash))) {
    await loginFailure(req, res, username);
    return;
  }
  if (user.mfaEnabledAt && user.mfaSecret) {
    if (!body.totp) {
      return res.status(401).json({ error: 'Enter the 6-digit code from your authenticator.', code: 'mfa_required' });
    }
    if (!verifyTotp(decryptMfaSecret(user.mfaSecret), body.totp)) {
      await loginFailure(req, res, username, 'mfa_invalid');
      return;
    }
  }

  await clearLoginFailures(req.ip, login);
  await setTrackedCookie(req, res, user);
  req.user = currentUserJson(user);
  await record(req, 'signed in', user.email, { sessionId: req.securitySession?.id });
  await cleanupSecurityRows().catch((error) => console.warn('Security cleanup failed:', (error as Error).message));
  res.json({ user: currentUserJson(user), needsFirstOwner: false });
}));

publicSecurityRouter.post('/first-owner', wrap(async (req, res) => {
  if ((await userCount()) > 0) return res.status(403).json({ error: 'The book already has an owner.' });
  const body = z.object({
    ...usernameFields,
    password: z.string().max(200),
  }).refine((value) => !!(value.username ?? value.email)?.trim(), { message: 'Enter a username.' }).parse(req.body);
  const username = body.username ?? body.email ?? '';
  const complaint = passwordComplaint(body.password);
  if (complaint) return res.status(400).json({ error: complaint });

  const created = await createUser(username, body.password, 'owner');
  const user = await getUser(created.id);
  if (!user) throw new Error('Could not read the owner after creating it.');
  await setTrackedCookie(req, res, user);
  req.user = currentUserJson(user);
  await record(req, 'book opened', user.email, { sessionId: req.securitySession?.id });
  res.status(201).json({ user: currentUserJson(user), needsFirstOwner: false });
}));

export const requireAuthenticatedApi: RequestHandler = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to open the book.' });
  return runWithRequestActor({ id: req.user.id, email: req.user.email }, () => next());
};

const ownerRequired: RequestHandler = (req, res, next) => {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Only an owner can change security access.' });
  }
  next();
};

const recentRequired: RequestHandler = wrap(async (req, res, next) => {
  if (!(await hasRecentAuthentication(req.securitySession?.id))) {
    return res.status(403).json({
      error: 'Unlock security changes with your current password first.',
      code: 'reauth_required',
    });
  }
  next();
});

export const protectedSecurityRouter = Router();

protectedSecurityRouter.post('/logout', wrap(async (req, res) => {
  if (req.securitySession?.id) {
    await revokeSecuritySession(req.user!.id, req.securitySession.id, req.user!.id);
    await record(req, 'signed out', req.user!.id, { sessionId: req.securitySession.id });
  }
  res.setHeader('Set-Cookie', cookieHeader('', 0));
  res.json({ ok: true });
}));

protectedSecurityRouter.get('/users', ownerRequired, wrap(async (_req, res) => {
  const rows = await listUsers();
  res.json({
    users: rows.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      active: u.active,
      createdAt: new Date(u.created_at).toISOString(),
      disabledAt: u.disabled_at ? new Date(u.disabled_at).toISOString() : null,
      mfaEnabled: !!u.mfa_enabled_at,
      lastSeen: u.last_seen ? new Date(u.last_seen).toISOString() : null,
    })),
    suggestion: suggestPassword(),
  });
}));

protectedSecurityRouter.post('/users', ownerRequired, recentRequired, wrap(async (req, res) => {
  const body = z.object({
    ...usernameFields,
    password: z.string().max(200),
    role: z.enum(['owner', 'entry']),
  }).refine((value) => !!(value.username ?? value.email)?.trim(), { message: 'Enter a username.' }).parse(req.body);
  const username = body.username ?? body.email ?? '';
  const complaint = passwordComplaint(body.password);
  if (complaint) return res.status(400).json({ error: complaint });
  if (await findUser(username)) {
    return res.status(409).json({
      error: 'That username already belongs to an existing or disabled user. Restore that user instead.',
    });
  }
  const user = await createUser(username, body.password, body.role);
  await record(req, 'person given access', user.id, { username: user.email, role: user.role });
  res.status(201).json({ user });
}));

protectedSecurityRouter.post('/users/:id/username', ownerRequired, recentRequired, wrap(async (req, res) => {
  const target = await getUser(String(req.params.id));
  if (!target || !target.active) return res.status(404).json({ error: 'No active person with that id.' });
  const { username } = z.object({ username: z.string().min(1).max(100) }).parse(req.body);
  const changed = await setUsername(target.id, username);
  await record(req, 'username changed', target.id, { from: target.email, to: changed.username });
  if (target.id === req.user!.id) {
    const fresh = await getUser(target.id);
    if (!fresh) throw new Error('Could not refresh current user.');
    req.user = currentUserJson(fresh);
    await setTrackedCookie(req, res, fresh);
  }
  res.json({ ok: true, username: changed.username });
}));

protectedSecurityRouter.post('/users/:id/password', ownerRequired, recentRequired, wrap(async (req, res) => {
  const target = await getUser(String(req.params.id));
  if (!target || !target.active) return res.status(404).json({ error: 'No active person with that id.' });
  const { password } = z.object({ password: z.string().max(200) }).parse(req.body);
  await setPassword(target.id, password);
  await record(req, 'password reset', target.id, { username: target.email });
  if (target.id === req.user!.id) {
    const fresh = await getUser(target.id);
    if (!fresh) throw new Error('Could not refresh current user.');
    await setTrackedCookie(req, res, fresh);
  }
  res.json({ ok: true });
}));

protectedSecurityRouter.post('/users/:id/role', ownerRequired, recentRequired, wrap(async (req, res) => {
  const target = await getUser(String(req.params.id));
  if (!target || !target.active) return res.status(404).json({ error: 'No active person with that id.' });
  const { role } = z.object({ role: z.enum(['owner', 'entry']) }).parse(req.body);
  if (target.role === 'owner' && role !== 'owner' && (await ownerCount()) === 1) {
    return res.status(400).json({ error: 'This is the only active owner — make someone else an owner first.' });
  }
  await setRole(target.id, role);
  await record(req, 'role changed', target.id, { username: target.email, role });
  if (target.id === req.user!.id) {
    const fresh = await getUser(target.id);
    if (!fresh) throw new Error('Could not refresh current user.');
    req.user = currentUserJson(fresh);
    await setTrackedCookie(req, res, fresh);
  }
  res.json({ ok: true });
}));

protectedSecurityRouter.post('/users/:id/restore', ownerRequired, recentRequired, wrap(async (req, res) => {
  const target = await getUser(String(req.params.id));
  if (!target) return res.status(404).json({ error: 'No such historical user.' });
  if (target.active) return res.status(409).json({ error: 'That user already has access.' });
  await restoreUser(target.id);
  await record(req, 'access restored', target.id, { username: target.email, role: target.role });
  await notifyActiveOwners('Access restored', `${target.email} can open the book again.`);
  res.json({ ok: true });
}));

protectedSecurityRouter.delete('/users/:id', ownerRequired, recentRequired, wrap(async (req, res) => {
  const target = await getUser(String(req.params.id));
  if (!target || !target.active) return res.status(404).json({ error: 'No active person with that id.' });
  if (target.id === req.user!.id) return res.status(400).json({ error: 'You cannot disable your own access.' });
  if (target.role === 'owner' && (await ownerCount()) === 1) {
    return res.status(400).json({ error: 'This is the only active owner.' });
  }
  await disableUser(target.id, req.user!.id);
  await record(req, 'access disabled', target.id, { username: target.email, role: target.role });
  await notifyActiveOwners('Access disabled', `${target.email} was disabled and all of their sessions were revoked.`);
  res.json({ ok: true });
}));

protectedSecurityRouter.post('/password', wrap(async (req, res) => {
  const { current, next } = z.object({ current: z.string().max(200), next: z.string().max(200) }).parse(req.body);
  const complaint = passwordComplaint(next);
  if (complaint) return res.status(400).json({ error: complaint });
  if (!(await checkPassword(current, (await getUser(req.user!.id))?.passwordHash ?? ''))) {
    return res.status(401).json({ error: 'That is not your current password.' });
  }
  await setPassword(req.user!.id, next);
  const fresh = await getUser(req.user!.id);
  if (!fresh) throw new Error('Could not refresh current user.');
  await setTrackedCookie(req, res, fresh);
  await record(req, 'password changed', req.user!.id, { username: req.user!.email });
  res.json({ ok: true });
}));

protectedSecurityRouter.get('/security', wrap(async (req, res) => {
  const user = await getUser(req.user!.id);
  if (!user) return res.status(401).json({ error: 'Sign in to open the book.' });
  const recent = await hasRecentAuthentication(req.securitySession?.id);
  const authenticatedAt = req.securitySession?.authenticatedAt
    ? new Date(req.securitySession.authenticatedAt).getTime()
    : 0;
  res.json({
    mfaEnabled: !!user.mfaEnabledAt,
    recentlyAuthenticated: recent,
    recentAuthExpiresAt: authenticatedAt
      ? new Date(authenticatedAt + RECENT_AUTH_SECONDS * 1000).toISOString()
      : null,
    sessions: await listSecuritySessions(user.id, req.securitySession?.id),
  });
}));

protectedSecurityRouter.post('/security/reauth', wrap(async (req, res) => {
  if (!req.securitySession?.id) {
    return res.status(401).json({ error: 'Sign in again to change security settings.' });
  }
  const body = z.object({ password: z.string().max(200), totp: z.string().max(20).optional() }).parse(req.body);
  const user = await getUser(req.user!.id);
  if (!user || !user.active || !(await checkPassword(body.password, user.passwordHash))) {
    await record(req, 'security reauthentication refused', req.user!.id);
    return res.status(401).json({ error: 'That is not your current password.' });
  }
  if (user.mfaEnabledAt && user.mfaSecret) {
    if (!body.totp) {
      return res.status(401).json({ error: 'Enter your authenticator code too.', code: 'mfa_required' });
    }
    if (!verifyTotp(decryptMfaSecret(user.mfaSecret), body.totp)) {
      await record(req, 'security reauthentication refused', req.user!.id, { reason: 'mfa' });
      return res.status(401).json({ error: 'That authenticator code is not valid.', code: 'mfa_invalid' });
    }
  }
  await markSessionReauthenticated(req.securitySession.id);
  req.securitySession.authenticatedAt = new Date().toISOString();
  await record(req, 'security reauthenticated', req.user!.id, { sessionId: req.securitySession.id });
  res.json({ ok: true, recentAuthSeconds: RECENT_AUTH_SECONDS });
}));

protectedSecurityRouter.post('/security/mfa/setup', ownerRequired, recentRequired, wrap(async (req, res) => {
  const user = await getUser(req.user!.id);
  if (!user) throw Object.assign(new Error('No such person.'), { status: 404 });
  if (user.mfaEnabledAt) return res.status(409).json({ error: 'Authenticator MFA is already enabled.' });
  const secret = generateTotpSecret();
  await query('UPDATE users SET mfa_pending_secret = $2 WHERE id = $1', [user.id, encryptMfaSecret(secret)]);
  await record(req, 'mfa setup started', user.id);
  res.json({ secret, uri: totpUri(user.email, secret) });
}));

protectedSecurityRouter.post('/security/mfa/enable', ownerRequired, recentRequired, wrap(async (req, res) => {
  const { code } = z.object({ code: z.string().max(20) }).parse(req.body);
  const user = await getUser(req.user!.id);
  if (!user?.mfaPendingSecret) return res.status(409).json({ error: 'Start authenticator setup first.' });
  const secret = decryptMfaSecret(user.mfaPendingSecret);
  if (!verifyTotp(secret, code)) return res.status(400).json({ error: 'That authenticator code is not valid.' });
  await query(
    `UPDATE users
        SET mfa_secret = mfa_pending_secret, mfa_pending_secret = NULL, mfa_enabled_at = now()
      WHERE id = $1`,
    [user.id],
  );
  await revokeUserSessions(user.id, user.id, req.securitySession?.id);
  await record(req, 'mfa enabled', user.id, { sessionId: req.securitySession?.id });
  await notifyActiveOwners('Authenticator enabled', `${user.email} enabled authenticator MFA.`);
  res.json({ ok: true });
}));

protectedSecurityRouter.post('/security/mfa/disable', ownerRequired, recentRequired, wrap(async (req, res) => {
  const { code } = z.object({ code: z.string().max(20) }).parse(req.body);
  const user = await getUser(req.user!.id);
  if (!user?.mfaEnabledAt || !user.mfaSecret) {
    return res.status(409).json({ error: 'Authenticator MFA is not enabled.' });
  }
  if (!verifyTotp(decryptMfaSecret(user.mfaSecret), code)) {
    return res.status(400).json({ error: 'That authenticator code is not valid.' });
  }
  await query(
    `UPDATE users
        SET mfa_secret = NULL, mfa_pending_secret = NULL, mfa_enabled_at = NULL
      WHERE id = $1`,
    [user.id],
  );
  await revokeUserSessions(user.id, user.id, req.securitySession?.id);
  await record(req, 'mfa disabled', user.id, { sessionId: req.securitySession?.id });
  await notifyActiveOwners('Authenticator disabled', `${user.email} disabled authenticator MFA.`);
  res.json({ ok: true });
}));

protectedSecurityRouter.delete('/security/sessions/:id', wrap(async (req, res) => {
  const targetId = String(req.params.id);
  const revoked = await revokeSecuritySession(req.user!.id, targetId, req.user!.id);
  if (!revoked) return res.status(404).json({ error: 'No active session with that id.' });
  await record(req, 'security session revoked', req.user!.id, { sessionId: targetId });
  if (targetId === req.securitySession?.id) res.setHeader('Set-Cookie', cookieHeader('', 0));
  res.json({ ok: true, signedOut: targetId === req.securitySession?.id });
}));

protectedSecurityRouter.post('/security/sessions/revoke-all', recentRequired, wrap(async (req, res) => {
  const count = await revokeUserSessions(req.user!.id, req.user!.id);
  await record(req, 'all security sessions revoked', req.user!.id, { count });
  res.setHeader('Set-Cookie', cookieHeader('', 0));
  res.json({ ok: true, count, signedOut: true });
}));

// The delegation router owns this endpoint. This fixed Express route adds the
// recent-auth requirement without choosing a permission from user-controlled path data.
protectedSecurityRouter.put('/delegation/users/:id/accounts', recentRequired, (_req, _res, next) => next());

protectedSecurityRouter.patch('/preferences/language', wrap(async (req, res) => {
  const language = (req.body as { language?: unknown } | undefined)?.language;
  if (language !== 'en' && language !== 'fr' && language !== 'ar') {
    return res.status(400).json({ error: 'Choose English, French or Arabic.' });
  }
  await query('UPDATE users SET language = $2 WHERE id = $1 AND active = true', [req.user!.id, language]);
  req.user!.language = language;
  res.json({ ok: true, language });
}));

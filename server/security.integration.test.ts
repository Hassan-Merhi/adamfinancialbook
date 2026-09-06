import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = 43129;
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = '2026-09-05';
const SERVER_SECRET = 'phase-6-integration-secret-that-is-long-enough';
let child: ReturnType<typeof spawn> | null = null;
let serverLog = '';

type Session = { cookie: string };

function sessionCookie(response: Response): string {
  const value = response.headers.get('set-cookie');
  if (!value) throw new Error('Expected session cookie');
  return value.split(';', 1)[0];
}

async function request(
  path: string,
  options: { method?: string; session?: Session; body?: unknown; bookHeader?: boolean } = {},
) {
  const method = options.method ?? 'GET';
  const headers = new Headers();
  if (options.session) headers.set('cookie', options.session.cookie);
  const needsBookHeader = method !== 'GET' && method !== 'HEAD'
    && path !== '/api/login' && path !== '/api/first-owner';
  if (needsBookHeader && options.bookHeader !== false) headers.set('x-book', '1');
  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${BASE}${path}`, { method, headers, body });
  const text = await response.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { response, data };
}

async function db<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: false });
  await client.connect();
  try { return (await client.query(sql, params)).rows as T[]; }
  finally { await client.end(); }
}

async function resetToLegacyShape(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: false });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await client.query(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  } finally { await client.end(); }
}

async function waitUntilHealthy(): Promise<void> {
  for (let i = 0; i < 150; i += 1) {
    if (child && child.exitCode !== null) throw new Error(`Server exited before health check:\n${serverLog}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server never became healthy:\n${serverLog}`);
}

async function startServer(): Promise<void> {
  serverLog = '';
  child = spawn(process.execPath, ['--import', 'tsx', 'server/start.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: DATABASE_URL!,
      SESSION_SECRET: SERVER_SECRET,
      MFA_ENCRYPTION_KEY: 'phase-6-dedicated-mfa-encryption-key',
      PGSSL: 'off',
      PGPOOL_MAX: '4',
      PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => { serverLog += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { serverLog += chunk.toString(); });
  await waitUntilHealthy();
}

async function stopServer(): Promise<void> {
  const running = child;
  if (!running || running.exitCode !== null) return;
  running.kill('SIGTERM');
  await Promise.race([once(running, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (running.exitCode === null) running.kill('SIGKILL');
  child = null;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(value: string): Buffer {
  let bits = '';
  for (const char of value.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret: string, timeMs = Date.now()): string {
  const counter = Math.floor(timeMs / 30_000);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(counterBytes).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  ) % 1_000_000;
  return String(value).padStart(6, '0');
}

describe.skipIf(!DATABASE_URL)('Phase 6 real PostgreSQL security', () => {
  const owner: Session = { cookie: '' };
  const delegate: Session = { cookie: '' };
  let ownerId = '';
  let delegateId = '';
  let businessId = '';
  let walletId = '';
  let spareAccountId = '';
  let delegatedEntryId = '';

  beforeAll(async () => {
    await resetToLegacyShape();
    await startServer();
  }, 30_000);

  afterAll(async () => {
    await stopServer();
    if (DATABASE_URL) {
      const client = new pg.Client({ connectionString: DATABASE_URL, ssl: false });
      await client.connect();
      try { await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); }
      finally { await client.end(); }
    }
  }, 15_000);

  it('upgrades the schema and creates a tracked owner session while the database protects the last owner', async () => {
    expect((await db<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')).map((x) => Number(x.version)))
      .toEqual([1, 2, 3, 4, 5, 6, 7]);

    const opened = await request('/api/first-owner', {
      method: 'POST', body: { email: 'secure-owner@example.com', password: 'OwnerSecure!2026' },
    });
    expect(opened.response.status).toBe(201);
    owner.cookie = sessionCookie(opened.response);
    ownerId = opened.data.user.id;

    const sessions = await db<{ seconds: number }>(
      `SELECT extract(epoch FROM (expires_at - created_at))::int AS seconds
         FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [ownerId],
    );
    expect(sessions).toHaveLength(1);
    expect(Number(sessions[0].seconds)).toBeGreaterThan(6 * 86_400);
    expect(Number(sessions[0].seconds)).toBeLessThanOrEqual(7 * 86_400 + 5);

    await expect(db('UPDATE users SET active = false WHERE id = $1', [ownerId])).rejects.toThrow(/last active owner/i);
    await expect(db('DELETE FROM users WHERE id = $1', [ownerId])).rejects.toThrow(/cannot be deleted/i);
    expect((await db<{ active: boolean }>('SELECT active FROM users WHERE id = $1', [ownerId]))[0].active).toBe(true);
  });

  it('persists login throttling across an API restart', async () => {
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      const wrong = await request('/api/login', {
        method: 'POST', body: { email: 'secure-owner@example.com', password: `WrongPassword!${attempt}` },
      });
      expect(wrong.response.status).toBe(401);
    }
    const locked = await request('/api/login', {
      method: 'POST', body: { email: 'secure-owner@example.com', password: 'WrongPassword!8' },
    });
    expect(locked.response.status).toBe(429);
    expect(Number((await db<{ n: string }>('SELECT count(*) AS n FROM login_throttle'))[0].n)).toBe(1);

    await stopServer();
    await startServer();

    const stillLocked = await request('/api/login', {
      method: 'POST', body: { email: 'secure-owner@example.com', password: 'OwnerSecure!2026' },
    });
    expect(stillLocked.response.status).toBe(429);
    expect(stillLocked.response.headers.get('retry-after')).toBeTruthy();
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM audit WHERE action = 'sign-in locked'`,
    ))[0].n)).toBeGreaterThan(0);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM notifications WHERE type = 'security_event'`,
    ))[0].n)).toBeGreaterThan(0);

    await db('DELETE FROM login_throttle');
    expect((await request('/api/book', { session: owner })).response.status).toBe(200);
  });

  it('requires recent authentication for access changes and enforces assignment rules in PostgreSQL', async () => {
    businessId = (await request('/api/businesses', {
      method: 'POST', session: owner, body: { name: 'Security Test Business' },
    })).data.id;
    walletId = (await request('/api/accounts', {
      method: 'POST', session: owner, body: { name: 'Delegated Wallet', businessId, opening: 250 },
    })).data.id;
    spareAccountId = (await request('/api/accounts', {
      method: 'POST', session: owner, body: { name: 'Spare Wallet', businessId, opening: 50 },
    })).data.id;

    await db(
      `UPDATE user_sessions SET authenticated_at = now() - interval '1 hour'
        WHERE user_id = $1 AND revoked_at IS NULL`, [ownerId],
    );
    const blocked = await request('/api/users', {
      method: 'POST', session: owner,
      body: { email: 'delegate-security@example.com', password: 'DelegateSecure!2026', role: 'entry' },
    });
    expect(blocked.response.status).toBe(403);
    expect(blocked.data.code).toBe('reauth_required');

    expect((await request('/api/security/reauth', {
      method: 'POST', session: owner, body: { password: 'OwnerSecure!2026' },
    })).response.status).toBe(200);

    const created = await request('/api/users', {
      method: 'POST', session: owner,
      body: { email: 'delegate-security@example.com', password: 'DelegateSecure!2026', role: 'entry' },
    });
    expect(created.response.status).toBe(201);
    delegateId = created.data.user.id;

    expect((await request(`/api/delegation/users/${delegateId}/accounts`, {
      method: 'PUT', session: owner, body: { accountIds: [walletId] },
    })).response.status).toBe(200);

    await expect(db(
      'INSERT INTO user_accounts (account_id, user_id) VALUES ($1,$2)', [spareAccountId, ownerId],
    )).rejects.toThrow(/entry-only/i);

    const login = await request('/api/login', {
      method: 'POST', body: { email: 'delegate-security@example.com', password: 'DelegateSecure!2026' },
    });
    expect(login.response.status).toBe(200);
    delegate.cookie = sessionCookie(login.response);
    const lifetime = (await db<{ seconds: number }>(
      `SELECT extract(epoch FROM (expires_at - created_at))::int AS seconds
         FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [delegateId],
    ))[0];
    expect(Number(lifetime.seconds)).toBeGreaterThan(86_300);
    expect(Number(lifetime.seconds)).toBeLessThanOrEqual(86_405);
  });

  it('blocks delegated API bypasses and preserves history when access is disabled and restored', async () => {
    const forbidden = [
      request('/api/businesses', { method: 'POST', session: delegate, body: { name: 'Nope' } }),
      request('/api/accounts', { method: 'POST', session: delegate, body: { name: 'Nope', opening: 0 } }),
      request('/api/projects', { method: 'POST', session: delegate, body: { name: 'Nope', businessId, opening: 0 } }),
      request('/api/people', { method: 'POST', session: delegate, body: { name: 'Nope', businessId, kind: 'payable', opening: 0, salary: 0, role: '' } }),
      request('/api/loans', { method: 'PUT', session: delegate, body: { fromBusiness: businessId, toBusiness: 'other', opening: 0 } }),
      request('/api/history', { session: delegate }),
      request('/api/backup.json', { session: delegate }),
      request('/api/export/entries.csv', { session: delegate }),
      request(`/api/delegation/users/${delegateId}/accounts`, { method: 'PUT', session: delegate, body: { accountIds: [] } }),
      request('/api/delegation/expense-reviews/assign', { method: 'POST', session: delegate, body: { entryIds: [], businessId, projectId: null } }),
      request('/api/entries/fake-entry', { method: 'PATCH', session: delegate, body: { amount: 1 } }),
      request('/api/entries/fake-entry/void', { method: 'POST', session: delegate, body: { reason: 'Nope' } }),
    ];
    for (const result of await Promise.all(forbidden)) expect(result.response.status).toBe(403);

    expect((await request('/api/entries', {
      method: 'POST', session: delegate,
      body: { occurredOn: DAY, kind: 'transfer', amount: 1, purpose: 'Nope', raw: '', accountId: walletId, toAccountId: spareAccountId },
    })).response.status).toBe(400);
    expect((await request('/api/entries', {
      method: 'POST', session: delegate,
      body: { occurredOn: DAY, kind: 'expense', amount: 1, purpose: 'Hidden', raw: '', accountId: spareAccountId },
    })).response.status).toBe(403);

    const posted = await request('/api/entries', {
      method: 'POST', session: delegate,
      body: { occurredOn: DAY, kind: 'expense', amount: 25, purpose: 'Preserved expense', raw: '', accountId: walletId },
    });
    expect(posted.response.status).toBe(201);
    delegatedEntryId = posted.data.id;

    expect((await request(`/api/users/${delegateId}`, {
      method: 'DELETE', session: owner, body: {},
    })).response.status).toBe(200);
    const disabled = (await db<{ active: boolean; disabled_at: Date | null }>(
      'SELECT active, disabled_at FROM users WHERE id = $1', [delegateId],
    ))[0];
    expect(disabled.active).toBe(false);
    expect(disabled.disabled_at).not.toBeNull();
    expect((await db<{ created_by: string }>('SELECT created_by FROM entries WHERE id = $1', [delegatedEntryId]))[0].created_by)
      .toBe(delegateId);
    expect((await request('/api/book', { session: delegate })).response.status).toBe(401);
    expect(Number((await db<{ n: string }>('SELECT count(*) AS n FROM users WHERE id = $1', [delegateId]))[0].n)).toBe(1);
    await expect(db('DELETE FROM users WHERE id = $1', [delegateId])).rejects.toThrow(/cannot be deleted/i);
    await expect(db(
      'INSERT INTO user_accounts (account_id, user_id) VALUES ($1,$2)', [walletId, delegateId],
    )).rejects.toThrow(/active entry-only/i);

    expect((await request(`/api/users/${delegateId}/restore`, {
      method: 'POST', session: owner, body: {},
    })).response.status).toBe(200);
    const restoredLogin = await request('/api/login', {
      method: 'POST', body: { email: 'delegate-security@example.com', password: 'DelegateSecure!2026' },
    });
    expect(restoredLogin.response.status).toBe(200);
    delegate.cookie = sessionCookie(restoredLogin.response);

    expect((await request('/api/entries', {
      method: 'POST', session: delegate,
      body: { occurredOn: DAY, kind: 'expense', amount: 1, purpose: 'No assignment yet', raw: '', accountId: walletId },
    })).response.status).toBe(403);
    expect((await request(`/api/delegation/users/${delegateId}/accounts`, {
      method: 'PUT', session: owner, body: { accountIds: [walletId] },
    })).response.status).toBe(200);
    expect((await request('/api/entries', {
      method: 'POST', session: delegate,
      body: { occurredOn: DAY, kind: 'expense', amount: 1, purpose: 'Restored access', raw: '', accountId: walletId },
    })).response.status).toBe(201);
  });

  it('lists sessions and revokes an individual delegated session immediately', async () => {
    const secondLogin = await request('/api/login', {
      method: 'POST', body: { email: 'delegate-security@example.com', password: 'DelegateSecure!2026' },
    });
    expect(secondLogin.response.status).toBe(200);
    const second: Session = { cookie: sessionCookie(secondLogin.response) };

    const state = await request('/api/security', { session: second });
    expect(state.response.status).toBe(200);
    const active = state.data.sessions.filter((session: any) => !session.revokedAt);
    expect(active.length).toBeGreaterThanOrEqual(2);
    const older = active.find((session: any) => !session.current);
    expect(older).toBeTruthy();

    expect((await request(`/api/security/sessions/${older.id}`, {
      method: 'DELETE', session: second, body: {},
    })).response.status).toBe(200);
    expect((await request('/api/book', { session: delegate })).response.status).toBe(401);
    delegate.cookie = second.cookie;
  });

  it('enables owner TOTP MFA, enforces it at login and reauthentication, and can disable it safely', async () => {
    expect((await request('/api/security/reauth', {
      method: 'POST', session: owner, body: { password: 'OwnerSecure!2026' },
    })).response.status).toBe(200);
    const setup = await request('/api/security/mfa/setup', { method: 'POST', session: owner, body: {} });
    expect(setup.response.status).toBe(200);
    expect(setup.data.secret).toMatch(/^[A-Z2-7]+$/);
    const code = totp(setup.data.secret);
    expect((await request('/api/security/mfa/enable', {
      method: 'POST', session: owner, body: { code },
    })).response.status).toBe(200);

    const stored = (await db<{ mfa_secret: string; mfa_enabled_at: Date | null }>(
      'SELECT mfa_secret, mfa_enabled_at FROM users WHERE id = $1', [ownerId],
    ))[0];
    expect(stored.mfa_enabled_at).not.toBeNull();
    expect(stored.mfa_secret).not.toContain(setup.data.secret);

    const missing = await request('/api/login', {
      method: 'POST', body: { email: 'secure-owner@example.com', password: 'OwnerSecure!2026' },
    });
    expect(missing.response.status).toBe(401);
    expect(missing.data.code).toBe('mfa_required');
    const invalid = await request('/api/login', {
      method: 'POST', body: { email: 'secure-owner@example.com', password: 'OwnerSecure!2026', totp: '000000' },
    });
    expect(invalid.response.status).toBe(401);
    expect(invalid.data.code).toBe('mfa_invalid');
    const valid = await request('/api/login', {
      method: 'POST', body: { email: 'secure-owner@example.com', password: 'OwnerSecure!2026', totp: totp(setup.data.secret) },
    });
    expect(valid.response.status).toBe(200);
    const mfaOwner: Session = { cookie: sessionCookie(valid.response) };

    const missingReauth = await request('/api/security/reauth', {
      method: 'POST', session: mfaOwner, body: { password: 'OwnerSecure!2026' },
    });
    expect(missingReauth.response.status).toBe(401);
    expect(missingReauth.data.code).toBe('mfa_required');
    expect((await request('/api/security/reauth', {
      method: 'POST', session: mfaOwner,
      body: { password: 'OwnerSecure!2026', totp: totp(setup.data.secret) },
    })).response.status).toBe(200);

    const sessions = await request('/api/security', { session: mfaOwner });
    const oldOwner = sessions.data.sessions.find((session: any) => !session.current && !session.revokedAt);
    expect(oldOwner).toBeTruthy();
    expect((await request(`/api/security/sessions/${oldOwner.id}`, {
      method: 'DELETE', session: mfaOwner, body: {},
    })).response.status).toBe(200);
    expect((await request('/api/book', { session: owner })).response.status).toBe(401);

    expect((await request('/api/security/mfa/disable', {
      method: 'POST', session: mfaOwner, body: { code: totp(setup.data.secret) },
    })).response.status).toBe(200);
    const withoutMfa = await request('/api/login', {
      method: 'POST', body: { email: 'secure-owner@example.com', password: 'OwnerSecure!2026' },
    });
    expect(withoutMfa.response.status).toBe(200);
    owner.cookie = sessionCookie(withoutMfa.response);
  });

  it('revokes every current-user session and keeps the full security audit trail', async () => {
    const second = await request('/api/login', {
      method: 'POST', body: { email: 'secure-owner@example.com', password: 'OwnerSecure!2026' },
    });
    const secondSession: Session = { cookie: sessionCookie(second.response) };
    expect((await request('/api/security/reauth', {
      method: 'POST', session: owner, body: { password: 'OwnerSecure!2026' },
    })).response.status).toBe(200);
    const revoked = await request('/api/security/sessions/revoke-all', {
      method: 'POST', session: owner, body: {},
    });
    expect(revoked.response.status).toBe(200);
    expect(revoked.data.count).toBeGreaterThanOrEqual(2);
    expect((await request('/api/book', { session: owner })).response.status).toBe(401);
    expect((await request('/api/book', { session: secondSession })).response.status).toBe(401);

    const actions = (await db<{ action: string }>(
      `SELECT action FROM audit WHERE action IN (
        'sign-in locked','security reauthenticated','access disabled','access restored',
        'mfa setup started','mfa enabled','mfa disabled','security session revoked','all security sessions revoked'
      ) ORDER BY id`,
    )).map((row) => row.action);
    for (const action of [
      'sign-in locked',
      'security reauthenticated',
      'access disabled',
      'access restored',
      'mfa setup started',
      'mfa enabled',
      'mfa disabled',
      'security session revoked',
      'all security sessions revoked',
    ]) expect(actions).toContain(action);
  });
});
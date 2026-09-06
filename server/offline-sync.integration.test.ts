import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = 43135;
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = '2026-09-06';
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
  options: { method?: string; session?: Session; body?: unknown } = {},
) {
  const method = options.method ?? 'GET';
  const headers = new Headers();
  if (options.session) headers.set('cookie', options.session.cookie);
  if (method !== 'GET' && method !== 'HEAD' && path !== '/api/login' && path !== '/api/first-owner') {
    headers.set('x-book', '1');
  }
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

function offlineContext(accountId: string, businessId: string, balance: number) {
  return {
    version: 1,
    capturedAt: '2026-09-06T06:00:00.000Z',
    sourceAccount: { id: accountId, businessId, balance },
    destinationAccount: null,
    project: null,
    person: null,
    receipt: null,
  };
}

describe.skipIf(!DATABASE_URL)('Phase 3/4 offline sync PostgreSQL safety', () => {
  const owner: Session = { cookie: '' };
  const delegate: Session = { cookie: '' };
  let business = '';
  let ownerCash = '';
  let wallet = '';
  let delegateId = '';

  beforeAll(async () => {
    await resetToLegacyShape();
    child = spawn(process.execPath, ['--import', 'tsx', 'server/start.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: DATABASE_URL!,
        SESSION_SECRET: 'offline-phase-4-integration-secret-long-enough',
        PGSSL: 'off',
        PGPOOL_MAX: '4',
        PORT: String(PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => { serverLog += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { serverLog += chunk.toString(); });
    await waitUntilHealthy();

    const opened = await request('/api/first-owner', {
      method: 'POST', body: { email: 'owner@example.com', password: 'OwnerPass!2026' },
    });
    expect(opened.response.status).toBe(201);
    owner.cookie = sessionCookie(opened.response);

    business = (await request('/api/businesses', {
      method: 'POST', session: owner, body: { name: 'Offline Test Business' },
    })).data.id;
    ownerCash = (await request('/api/accounts', {
      method: 'POST', session: owner,
      body: { name: 'Owner Cash', businessId: business, opening: 1000 },
    })).data.id;
    wallet = (await request('/api/accounts', {
      method: 'POST', session: owner,
      body: { name: 'Offline Wallet', businessId: business, opening: 0 },
    })).data.id;

    const user = await request('/api/users', {
      method: 'POST', session: owner,
      body: { email: 'delegate@example.com', password: 'DelegatePass!2026', role: 'entry' },
    });
    delegateId = user.data.user.id;
    expect((await request(`/api/delegation/users/${delegateId}/accounts`, {
      method: 'PUT', session: owner, body: { accountIds: [wallet] },
    })).response.status).toBe(200);

    const login = await request('/api/login', {
      method: 'POST', body: { email: 'delegate@example.com', password: 'DelegatePass!2026' },
    });
    delegate.cookie = sessionCookie(login.response);
  }, 30_000);

  afterAll(async () => {
    const running = child;
    if (running && running.exitCode === null) {
      running.kill('SIGTERM');
      await Promise.race([once(running, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (running.exitCode === null) running.kill('SIGKILL');
    }
    if (DATABASE_URL) {
      const client = new pg.Client({ connectionString: DATABASE_URL, ssl: false });
      await client.connect();
      try { await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); }
      finally { await client.end(); }
    }
  }, 15_000);

  it('keeps Phase 3 handoff replay idempotent', async () => {
    const body = {
      fromAccountId: ownerCash,
      toAccountId: wallet,
      amount: 250,
      purpose: 'Offline wallet funding',
      occurredOn: DAY,
      clientRef: 'q_phase3_same_handoff',
    };

    const [a, b] = await Promise.all([
      request('/api/delegation/transfers', { method: 'POST', session: owner, body }),
      request('/api/delegation/transfers', { method: 'POST', session: owner, body }),
    ]);

    expect([a.response.status, b.response.status].sort()).toEqual([200, 201]);
    expect(a.data.id).toBe(b.data.id);
    const handoffId = a.data.id as string;
    expect(handoffId).toMatch(/^xfr_sync_[a-f0-9]{32}$/);

    const mismatch = await request('/api/delegation/transfers', {
      method: 'POST', session: owner, body: { ...body, amount: 251 },
    });
    expect(mismatch.response.status).toBe(409);
    expect(mismatch.data.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const confirm = await request(`/api/delegation/transfers/${handoffId}/confirm`, {
      method: 'POST', session: delegate, body: {},
    });
    expect(confirm.response.status).toBe(200);

    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM pending_transfers WHERE id = $1', [handoffId],
    ))[0].n)).toBe(1);
    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM entries WHERE client_ref = $1', [`handoff_${handoffId}`],
    ))[0].n)).toBe(1);

    const book = await request('/api/book', { session: owner });
    expect(book.data.balances.accounts[ownerCash]).toBe(750);
    expect(book.data.balances.accounts[wallet]).toBe(250);
  });

  it('refuses a stale balance without posting, then accepts the same reviewed intent after rebase', async () => {
    const onlineSpend = await request('/api/entries', {
      method: 'POST', session: owner,
      body: {
        occurredOn: DAY,
        kind: 'expense',
        amount: 25,
        purpose: 'Owner changed wallet while delegate was offline',
        raw: 'owner spend',
        accountId: wallet,
        clientRef: 'online_wallet_change',
      },
    });
    expect(onlineSpend.response.status).toBe(201);

    const offlineBody = {
      occurredOn: DAY,
      kind: 'expense',
      amount: 100,
      purpose: 'Offline materials',
      raw: 'Offline materials',
      accountId: wallet,
      clientRef: 'q_phase4_stale',
      offlineContext: offlineContext(wallet, business, 250),
    };
    const stale = await request('/api/entries', { method: 'POST', session: delegate, body: offlineBody });
    expect(stale.response.status).toBe(409);
    expect(stale.data.code).toBe('OFFLINE_CONFLICT_STALE_BALANCE');
    expect(String(stale.data.error)).toContain('$250.00');
    expect(String(stale.data.error)).toContain('$225.00');
    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM entries WHERE client_ref = $1', ['q_phase4_stale'],
    ))[0].n)).toBe(0);

    const reviewed = await request('/api/entries', {
      method: 'POST', session: delegate,
      body: { ...offlineBody, offlineContext: offlineContext(wallet, business, 225) },
    });
    expect(reviewed.response.status).toBe(201);

    const replay = await request('/api/entries', {
      method: 'POST', session: delegate,
      body: { ...offlineBody, offlineContext: offlineContext(wallet, business, 225) },
    });
    expect(replay.response.status).toBe(200);
    expect(replay.data.id).toBe(reviewed.data.id);

    const reusedDifferent = await request('/api/entries', {
      method: 'POST', session: delegate,
      body: { ...offlineBody, amount: 101, offlineContext: offlineContext(wallet, business, 125) },
    });
    expect(reusedDifferent.response.status).toBe(409);
    expect(reusedDifferent.data.code).toBe('OFFLINE_CONFLICT_IDEMPOTENCY_KEY_REUSED');
  });

  it('turns removed account access into a reviewable permission conflict', async () => {
    const removed = await request(`/api/delegation/users/${delegateId}/accounts`, {
      method: 'PUT', session: owner, body: { accountIds: [] },
    });
    expect(removed.response.status).toBe(200);

    const attempt = await request('/api/entries', {
      method: 'POST', session: delegate,
      body: {
        occurredOn: DAY,
        kind: 'expense',
        amount: 10,
        purpose: 'Queued before access changed',
        raw: 'Queued before access changed',
        accountId: wallet,
        clientRef: 'q_phase4_permission',
        offlineContext: offlineContext(wallet, business, 125),
      },
    });
    expect(attempt.response.status).toBe(409);
    expect(attempt.data.code).toBe('OFFLINE_CONFLICT_PERMISSION_CHANGED');
    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM entries WHERE client_ref = $1', ['q_phase4_permission'],
    ))[0].n)).toBe(0);

    expect((await request(`/api/delegation/users/${delegateId}/accounts`, {
      method: 'PUT', session: owner, body: { accountIds: [wallet] },
    })).response.status).toBe(200);
  });

  it('serializes two devices so stale concurrent spending cannot overdraw one wallet', async () => {
    const body = (clientRef: string) => ({
      occurredOn: DAY,
      kind: 'expense',
      amount: 80,
      purpose: `Concurrent offline spend ${clientRef}`,
      raw: `Concurrent offline spend ${clientRef}`,
      accountId: wallet,
      clientRef,
      offlineContext: offlineContext(wallet, business, 125),
    });

    const [a, b] = await Promise.all([
      request('/api/entries', { method: 'POST', session: delegate, body: body('q_phase4_device_a') }),
      request('/api/entries', { method: 'POST', session: delegate, body: body('q_phase4_device_b') }),
    ]);

    const statuses = [a.response.status, b.response.status].sort();
    expect(statuses).toEqual([201, 409]);
    const failed = a.response.status === 409 ? a : b;
    expect(failed.data.code).toBe('OFFLINE_CONFLICT_INSUFFICIENT_FUNDS');

    const book = await request('/api/book', { session: owner });
    expect(book.data.balances.accounts[wallet]).toBe(45);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM entries
        WHERE client_ref IN ('q_phase4_device_a','q_phase4_device_b')`,
    ))[0].n)).toBe(1);
  });
});

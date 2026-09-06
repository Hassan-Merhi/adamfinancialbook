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

describe.skipIf(!DATABASE_URL)('Phase 3 offline sync PostgreSQL idempotency', () => {
  const owner: Session = { cookie: '' };
  const delegate: Session = { cookie: '' };
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
        SESSION_SECRET: 'offline-phase-3-integration-secret-long-enough',
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

    const business = (await request('/api/businesses', {
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

  it('creates one delegated handoff under concurrent replay and returns it on later retries', async () => {
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
    expect(a.data.id).toMatch(/^xfr_sync_[a-f0-9]{32}$/);
    const handoffId = a.data.id as string;

    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM pending_transfers WHERE id = $1', [handoffId],
    ))[0].n)).toBe(1);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM notifications
        WHERE user_id = $1 AND type = 'transfer_waiting' AND related_id = $2`,
      [delegateId, handoffId],
    ))[0].n)).toBe(1);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM audit
        WHERE action = 'delegated transfer awaiting confirmation' AND subject = $1`,
      [handoffId],
    ))[0].n)).toBe(1);

    const mismatch = await request('/api/delegation/transfers', {
      method: 'POST', session: owner, body: { ...body, amount: 251 },
    });
    expect(mismatch.response.status).toBe(409);
    expect(mismatch.data.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const confirm = await request(`/api/delegation/transfers/${handoffId}/confirm`, {
      method: 'POST', session: delegate, body: {},
    });
    expect(confirm.response.status).toBe(200);

    const replayAfterConfirm = await request('/api/delegation/transfers', {
      method: 'POST', session: owner, body,
    });
    expect(replayAfterConfirm.response.status).toBe(200);
    expect(replayAfterConfirm.data).toMatchObject({ id: handoffId, status: 'confirmed' });

    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM entries WHERE client_ref = $1', [`handoff_${handoffId}`],
    ))[0].n)).toBe(1);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM notifications
        WHERE user_id = $1 AND type = 'transfer_waiting' AND related_id = $2`,
      [delegateId, handoffId],
    ))[0].n)).toBe(1);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM audit
        WHERE action = 'delegated transfer awaiting confirmation' AND subject = $1`,
      [handoffId],
    ))[0].n)).toBe(1);

    const book = await request('/api/book', { session: owner });
    expect(book.data.balances.accounts[ownerCash]).toBe(750);
    expect(book.data.balances.accounts[wallet]).toBe(250);
  });
});

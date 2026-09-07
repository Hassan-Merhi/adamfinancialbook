import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = 43136;
const BASE = `http://127.0.0.1:${PORT}`;

let child: ReturnType<typeof spawn> | null = null;
let serverLog = '';

type Session = { cookie: string };

function sessionCookie(response: Response): string {
  const value = response.headers.get('set-cookie');
  if (!value) throw new Error('Expected session cookie');
  return value.split(';', 1)[0];
}

async function request(path: string, options: { method?: string; body?: unknown; session?: Session } = {}) {
  const headers = new Headers();
  if (options.session) headers.set('cookie', options.session.cookie);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { response, data };
}

async function stopServer(): Promise<void> {
  const running = child;
  if (!running || running.exitCode !== null) return;
  running.kill('SIGTERM');
  await Promise.race([once(running, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (running.exitCode === null) running.kill('SIGKILL');
  child = null;
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
  // Hosted CI can spend several seconds scheduling the freshly spawned Node
  // process while PostgreSQL and other parallel jobs are also under load. The
  // previous 15-second watchdog could expire after the API had already logged
  // that it was listening. Keep health itself strict, but give startup 30s so
  // runner scheduling cannot turn a healthy server into a false failure.
  for (let i = 0; i < 300; i += 1) {
    if (child && child.exitCode !== null) throw new Error(`Server exited before health check:\n${serverLog}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server never became healthy:\n${serverLog}`);
}

describe.skipIf(!DATABASE_URL)('Phase 4 delegated handoff confirmation safety', () => {
  const owner: Session = { cookie: '' };
  const delegate: Session = { cookie: '' };
  let source = '';
  let wallet = '';

  beforeAll(async () => {
    await resetToLegacyShape();
    child = spawn(process.execPath, ['--import', 'tsx', 'server/start.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: DATABASE_URL!,
        SESSION_SECRET: 'offline-phase-4-confirmation-secret-long-enough',
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
      method: 'POST', session: owner, body: { name: 'Confirmation Safety' },
    })).data.id;
    source = (await request('/api/accounts', {
      method: 'POST', session: owner, body: { name: 'Source', businessId: business, opening: 100 },
    })).data.id;
    wallet = (await request('/api/accounts', {
      method: 'POST', session: owner, body: { name: 'Wallet', businessId: business, opening: 0 },
    })).data.id;

    const created = await request('/api/users', {
      method: 'POST', session: owner, body: { email: 'delegate', password: 'DelegatePass!2026', role: 'entry' },
    });
    expect(created.response.status).toBe(201);
    const delegateId = created.data.user.id;
    await request(`/api/delegation/users/${delegateId}/accounts`, {
      method: 'PUT', session: owner, body: { accountIds: [wallet] },
    });

    const login = await request('/api/login', {
      method: 'POST', body: { email: 'delegate', password: 'DelegatePass!2026' },
    });
    expect(login.response.status).toBe(200);
    delegate.cookie = sessionCookie(login.response);
  }, 40_000);

  afterAll(async () => {
    await stopServer();
    if (DATABASE_URL) {
      const client = new pg.Client({ connectionString: DATABASE_URL, ssl: false });
      await client.connect();
      try { await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); }
      finally { await client.end(); }
    }
  }, 20_000);

  it('does not overdraw when funds disappear after handoff creation but before confirmation', async () => {
    const handoff = await request('/api/pending-transfers', {
      method: 'POST', session: owner, body: { fromAccountId: source, toAccountId: wallet, amount: 80, note: 'cash handoff' },
    });
    expect(handoff.response.status).toBe(201);

    const spend = await request('/api/entries', {
      method: 'POST', session: owner,
      body: {
        occurredOn: '2026-09-06', kind: 'expense', amount: 30,
        purpose: 'spent before confirmation', raw: 'spent before confirmation', accountId: source,
      },
    });
    expect(spend.response.status).toBe(201);

    const confirmation = await request(`/api/pending-transfers/${handoff.data.id}/confirm`, {
      method: 'POST', session: delegate, body: {},
    });
    expect(confirmation.response.status).toBe(409);
    expect(confirmation.data.error).toMatch(/enough money|insufficient|available/i);

    const balance = await db<{ balance: string }>(
      `SELECT opening + COALESCE((SELECT sum(delta) FROM effects WHERE type = 'account' AND target_id = $1 AND active = true), 0) AS balance
         FROM accounts WHERE id = $1`,
      [source],
    );
    expect(Number(balance[0].balance)).toBe(70);
  });
});

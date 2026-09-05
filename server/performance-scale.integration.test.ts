import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = 43130;
const BASE = `http://127.0.0.1:${PORT}`;
const SCALE_ROWS = 5_000;
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
  if (method !== 'GET' && method !== 'HEAD' && path !== '/api/first-owner' && path !== '/api/login') {
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

async function resetDatabase() {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: false });
  await client.connect();
  try { await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); }
  finally { await client.end(); }
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
      SESSION_SECRET: 'phase-7-scale-session-secret-that-is-long-enough',
      MFA_ENCRYPTION_KEY: 'phase-7-scale-mfa-encryption-key-that-is-long-enough',
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

describe.skipIf(!DATABASE_URL)('Phase 7 large-book performance contract', () => {
  const owner: Session = { cookie: '' };
  let ownerId = '';
  let accountId = '';

  beforeAll(async () => {
    await resetDatabase();
    await startServer();

    const opened = await request('/api/first-owner', {
      method: 'POST', body: { email: 'scale-owner@example.com', password: 'ScaleOwner!2026' },
    });
    expect(opened.response.status).toBe(201);
    owner.cookie = sessionCookie(opened.response);
    ownerId = opened.data.user.id;

    const business = await request('/api/businesses', {
      method: 'POST', session: owner, body: { name: 'Scale Business' },
    });
    expect(business.response.status).toBe(201);
    const account = await request('/api/accounts', {
      method: 'POST', session: owner,
      body: { name: 'Scale Cash', businessId: business.data.id, opening: 10_000 },
    });
    expect(account.response.status).toBe(201);
    accountId = account.data.id;

    await db(
      `INSERT INTO entries (
         id, occurred_on, kind, amount, purpose, raw, account_id, historical,
         created_by, transaction_id, created_at
       )
       SELECT 'scale_entry_' || g,
              DATE '2025-01-01' + ((g - 1) % 365),
              'expense', 1, 'Scale expense ' || g, '', $1, true,
              $2, 'txn_scale_' || g,
              TIMESTAMPTZ '2025-01-01 00:00:00+00' + (g * interval '1 second')
         FROM generate_series(1, $3::int) AS g`,
      [accountId, ownerId, SCALE_ROWS],
    );
    await db(
      `INSERT INTO effects (entry_id, type, target_id, delta, active)
       SELECT id, 'account', $1, -1, true
         FROM entries
        WHERE id LIKE 'scale_entry_%'`,
      [accountId],
    );
    await db(
      `INSERT INTO audit (at, actor, actor_email, action, subject, detail)
       SELECT TIMESTAMPTZ '2025-01-01 00:00:00+00' + (g * interval '1 second'),
              $1, 'scale-owner@example.com', 'scale event', 'scale_' || g, '{}'::jsonb
         FROM generate_series(1, 1500) AS g`,
      [ownerId],
    );
  }, 45_000);

  afterAll(async () => {
    await stopServer();
    if (DATABASE_URL) await resetDatabase();
  }, 15_000);

  it('keeps startup, statements, search and history bounded as the ledger grows', async () => {
    const overviewStarted = performance.now();
    const overview = await request('/api/overview?today=2026-09-06', { session: owner });
    const overviewMs = performance.now() - overviewStarted;
    expect(overview.response.status).toBe(200);
    expect(overview.data.entries).toHaveLength(40);
    expect(overview.data.balances.accounts[accountId]).toBe(5_000);
    const overviewBytes = Buffer.byteLength(JSON.stringify(overview.data));
    expect(overviewBytes).toBeLessThan(100_000);

    const statementStarted = performance.now();
    const first = await request(`/api/statement-page?type=account&id=${accountId}&limit=50`, { session: owner });
    const statementMs = performance.now() - statementStarted;
    expect(first.response.status).toBe(200);
    expect(first.data.items).toHaveLength(50);
    expect(first.data.total).toBe(SCALE_ROWS);
    expect(first.data.nextCursor).toBeTruthy();
    expect(first.data.outSum).toBe(-SCALE_ROWS);

    const second = await request(
      `/api/statement-page?type=account&id=${accountId}&limit=50&cursor=${encodeURIComponent(first.data.nextCursor)}`,
      { session: owner },
    );
    expect(second.response.status).toBe(200);
    expect(second.data.items).toHaveLength(50);
    expect(second.data.items[0].entry.id).not.toBe(first.data.items[0].entry.id);

    const searched = await request('/api/search/entries?q=Scale&limit=12', { session: owner });
    expect(searched.response.status).toBe(200);
    expect(searched.data.items).toHaveLength(12);

    const history = await request('/api/history-page?limit=50', { session: owner });
    expect(history.response.status).toBe(200);
    expect(history.data.lines).toHaveLength(50);
    expect(history.data.nextCursor).toBeTruthy();

    const indexes = await db<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [[
        'entries_active_recent_idx',
        'entries_active_account_idx',
        'entries_search_idx',
        'effects_active_target_entry_idx',
      ]],
    );
    expect(indexes.map((row) => row.indexname)).toEqual([
      'effects_active_target_entry_idx',
      'entries_active_account_idx',
      'entries_active_recent_idx',
      'entries_search_idx',
    ]);

    console.info(JSON.stringify({
      event: 'phase7.scale.metrics',
      rows: SCALE_ROWS,
      overviewBytes,
      overviewMs: Number(overviewMs.toFixed(1)),
      statementMs: Number(statementMs.toFixed(1)),
    }));
  }, 20_000);
});

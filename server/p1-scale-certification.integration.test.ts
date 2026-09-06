import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = 43191;
const BASE = `http://127.0.0.1:${PORT}`;

const BUSINESSES = 100;
const ACCOUNTS = 1_000;
const USERS = 30;
const EXPENSE_ENTRIES = 200_000;
const TRANSFER_ENTRIES = 50_000;
const TOTAL_ENTRIES = EXPENSE_ENTRIES + TRANSFER_ENTRIES;
const AUDIT_ROWS = 100_000;
const ATTACHMENTS = 25_000;

let child: ReturnType<typeof spawn> | null = null;
let serverLog = '';

type Session = { cookie: string };

function sessionCookie(response: Response): string {
  const value = response.headers.get('set-cookie');
  if (!value) throw new Error('Expected session cookie');
  return value.split(';', 1)[0];
}

async function request(path: string, session?: Session) {
  const headers = new Headers();
  if (session) headers.set('cookie', session.cookie);
  const started = performance.now();
  const response = await fetch(`${BASE}${path}`, { headers });
  const elapsedMs = performance.now() - started;
  const text = await response.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { response, data, elapsedMs, bytes: Buffer.byteLength(text) };
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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
  for (let i = 0; i < 180; i += 1) {
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
      SESSION_SECRET: 'p1-scale-certification-session-secret-long-enough',
      MFA_ENCRYPTION_KEY: 'p1-scale-certification-mfa-key-long-enough',
      PGSSL: 'off',
      PGPOOL_MAX: '12',
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

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

async function measure(path: string, session: Session, samples = 10) {
  const values: number[] = [];
  let last: Awaited<ReturnType<typeof request>> | null = null;
  // Warm the database/query plan before measuring. The P1 target is steady-state
  // product latency, not PostgreSQL process startup.
  const warm = await request(path, session);
  expect(warm.response.status).toBe(200);
  for (let i = 0; i < samples; i += 1) {
    last = await request(path, session);
    expect(last.response.status).toBe(200);
    values.push(last.elapsedMs);
  }
  return {
    p95: percentile95(values),
    max: Math.max(...values),
    min: Math.min(...values),
    bytes: last?.bytes ?? 0,
    data: last?.data,
  };
}

describe.skipIf(!DATABASE_URL)('P1 production-scale PostgreSQL certification', () => {
  const owner: Session = { cookie: '' };
  const delegates: Session[] = [];
  let ownerId = '';

  beforeAll(async () => {
    await resetDatabase();
    await startServer();

    const opened = await post('/api/first-owner', {
      email: 'p1-scale-owner',
      password: 'P1ScaleOwner!2026',
    });
    expect(opened.response.status).toBe(201);
    owner.cookie = sessionCookie(opened.response);
    ownerId = opened.data.user.id as string;

    await db(
      `INSERT INTO businesses (id, name, created_at)
       SELECT 'p1_biz_' || g, 'P1 Business ' || g,
              TIMESTAMPTZ '2021-01-01 00:00:00+00' + (g * interval '1 second')
         FROM generate_series(1, $1::int) AS g`,
      [BUSINESSES],
    );

    await db(
      `INSERT INTO accounts (id, name, business_id, opening, created_at)
       SELECT 'p1_acc_' || g, 'P1 Account ' || g,
              'p1_biz_' || (((g - 1) % $1::int) + 1),
              1000000,
              TIMESTAMPTZ '2021-01-02 00:00:00+00' + (g * interval '1 second')
         FROM generate_series(1, $2::int) AS g`,
      [BUSINESSES, ACCOUNTS],
    );

    await db(
      `INSERT INTO users (id, email, password_hash, role, language, created_at)
       SELECT 'p1_user_' || g,
              'p1-scale-user-' || g,
              source.password_hash,
              'entry', 'en',
              TIMESTAMPTZ '2021-01-03 00:00:00+00' + (g * interval '1 second')
         FROM users source
         CROSS JOIN generate_series(1, $2::int) AS g
        WHERE source.id = $1`,
      [ownerId, USERS - 1],
    );

    await db(
      `INSERT INTO user_accounts (account_id, user_id, created_at)
       SELECT 'p1_acc_' || g, 'p1_user_' || g,
              TIMESTAMPTZ '2021-01-04 00:00:00+00' + (g * interval '1 second')
         FROM generate_series(1, $1::int) AS g`,
      [USERS - 1],
    );

    for (let index = 1; index < USERS; index += 1) {
      const loggedIn = await post('/api/login', {
        email: `p1-scale-user-${index}`,
        password: 'P1ScaleOwner!2026',
      });
      expect(loggedIn.response.status).toBe(200);
      delegates.push({ cookie: sessionCookie(loggedIn.response) });
    }

    await db(
      `INSERT INTO entries (
         id, occurred_on, kind, amount, purpose, raw, account_id, historical,
         created_by, transaction_id, created_at
       )
       SELECT 'p1_exp_' || g,
              DATE '2021-01-01' + ((g - 1) % 1825),
              'expense', 1,
              'P1 scale expense ' || g,
              'P1 scale expense ' || g,
              'p1_acc_' || (((g - 1) % $1::int) + 1),
              true, $2,
              'p1_tx_exp_' || g,
              TIMESTAMPTZ '2021-01-01 00:00:00+00' + (g * interval '1 second')
         FROM generate_series(1, $3::int) AS g`,
      [ACCOUNTS, ownerId, EXPENSE_ENTRIES],
    );

    await db(
      `INSERT INTO entries (
         id, occurred_on, kind, amount, purpose, raw, account_id, to_account_id,
         historical, created_by, transaction_id, created_at
       )
       SELECT 'p1_transfer_' || g,
              DATE '2021-01-01' + ((g - 1) % 1825),
              'transfer', 2,
              'P1 scale transfer ' || g,
              'P1 scale transfer ' || g,
              'p1_acc_' || (((g - 1) % $1::int) + 1),
              'p1_acc_' || (((g - 1 + ($1::int / 2)) % $1::int) + 1),
              true, $2,
              'p1_tx_transfer_' || g,
              TIMESTAMPTZ '2025-12-31 00:00:00+00' + (g * interval '1 second')
         FROM generate_series(1, $3::int) AS g`,
      [ACCOUNTS, ownerId, TRANSFER_ENTRIES],
    );

    await db(
      `INSERT INTO effects (entry_id, type, target_id, delta, active)
       SELECT id, 'account', account_id, -amount, true
         FROM entries
        WHERE id LIKE 'p1_exp_%'`,
    );

    await db(
      `INSERT INTO effects (entry_id, type, target_id, delta, active)
       SELECT id, 'account', account_id, -amount, true
         FROM entries
        WHERE id LIKE 'p1_transfer_%'
       UNION ALL
       SELECT id, 'account', to_account_id, amount, true
         FROM entries
        WHERE id LIKE 'p1_transfer_%'`,
    );

    await db(
      `INSERT INTO audit (at, actor, actor_email, action, subject, detail)
       SELECT TIMESTAMPTZ '2021-01-01 00:00:00+00' + (g * interval '1 second'),
              $1, 'p1-scale-owner', 'p1 scale event', 'p1_audit_' || g,
              jsonb_build_object('row', g)
         FROM generate_series(1, $2::int) AS g`,
      [ownerId, AUDIT_ROWS],
    );

    await db(
      `INSERT INTO attachments (
         id, uploaded_by, entry_id, filename, mime_type, byte_size, data, created_at
       )
       SELECT 'p1_attachment_' || g,
              $1,
              'p1_exp_' || g,
              'receipt-' || g || '.png',
              'image/png',
              4,
              decode('89504e47', 'hex'),
              TIMESTAMPTZ '2025-01-01 00:00:00+00' + (g * interval '1 second')
         FROM generate_series(1, $2::int) AS g`,
      [ownerId, ATTACHMENTS],
    );

    await db('ANALYZE businesses; ANALYZE accounts; ANALYZE users; ANALYZE entries; ANALYZE effects; ANALYZE audit; ANALYZE attachments;');
  }, 120_000);

  afterAll(async () => {
    await stopServer();
    if (DATABASE_URL) await resetDatabase();
  }, 20_000);

  it('proves the full P1 production-sized dataset is present', async () => {
    const counts = await db<{
      businesses: string;
      accounts: string;
      users: string;
      entries: string;
      transfers: string;
      audit: string;
      attachments: string;
    }>(`
      SELECT
        (SELECT count(*) FROM businesses) AS businesses,
        (SELECT count(*) FROM accounts) AS accounts,
        (SELECT count(*) FROM users) AS users,
        (SELECT count(*) FROM entries WHERE id LIKE 'p1_%') AS entries,
        (SELECT count(*) FROM entries WHERE id LIKE 'p1_transfer_%') AS transfers,
        (SELECT count(*) FROM audit WHERE subject LIKE 'p1_audit_%') AS audit,
        (SELECT count(*) FROM attachments WHERE id LIKE 'p1_attachment_%') AS attachments
    `);
    expect(Number(counts[0].businesses)).toBe(BUSINESSES);
    expect(Number(counts[0].accounts)).toBe(ACCOUNTS);
    expect(Number(counts[0].users)).toBe(USERS);
    expect(Number(counts[0].entries)).toBe(TOTAL_ENTRIES);
    expect(Number(counts[0].transfers)).toBe(TRANSFER_ENTRIES);
    expect(Number(counts[0].audit)).toBe(AUDIT_ROWS);
    expect(Number(counts[0].attachments)).toBe(ATTACHMENTS);
  });

  it('holds focused API p95 below 500 ms and heavy historical overview below 1.5 s', async () => {
    const statement = await measure('/api/statement-page?type=account&id=p1_acc_1&limit=50', owner, 12);
    const search = await measure('/api/search/entries?q=scale%20expense&limit=20', owner, 12);
    const history = await measure('/api/history-page?limit=50', owner, 12);
    const files = await measure('/api/files-page?limit=40', owner, 12);
    const overview = await measure('/api/overview?today=2026-09-06', owner, 8);
    const historical = await measure('/api/overview?on=2025-12-30&today=2026-09-06', owner, 5);

    expect(statement.p95).toBeLessThan(500);
    expect(search.p95).toBeLessThan(500);
    expect(history.p95).toBeLessThan(500);
    expect(files.p95).toBeLessThan(500);
    expect(overview.p95).toBeLessThan(500);
    expect(historical.p95).toBeLessThan(1_500);

    expect(statement.bytes).toBeLessThan(150_000);
    expect(search.bytes).toBeLessThan(100_000);
    expect(history.bytes).toBeLessThan(100_000);
    expect(files.bytes).toBeLessThan(150_000);
    expect(overview.bytes).toBeLessThan(400_000);
    expect(historical.bytes).toBeLessThan(400_000);

    console.info(JSON.stringify({
      event: 'p1.scale.certified',
      dataset: {
        businesses: BUSINESSES,
        accounts: ACCOUNTS,
        users: USERS,
        entries: TOTAL_ENTRIES,
        transfers: TRANSFER_ENTRIES,
        audit: AUDIT_ROWS,
        attachments: ATTACHMENTS,
      },
      p95Ms: {
        statement: Number(statement.p95.toFixed(1)),
        search: Number(search.p95.toFixed(1)),
        history: Number(history.p95.toFixed(1)),
        files: Number(files.p95.toFixed(1)),
        overview: Number(overview.p95.toFixed(1)),
        historicalOverview: Number(historical.p95.toFixed(1)),
      },
    }));
  }, 60_000);

  it('serves 30 simultaneous authenticated users without errors or queue collapse', async () => {
    const sessions = [owner, ...delegates];
    expect(sessions).toHaveLength(USERS);
    const started = performance.now();
    const responses = await Promise.all(sessions.map((session, index) => request(
      `/api/statement-page?type=account&id=p1_acc_${Math.max(1, index)}&limit=25`,
      session,
    )));
    const wallMs = performance.now() - started;
    const individual = responses.map((result) => result.elapsedMs);

    expect(responses.every((result) => result.response.status === 200)).toBe(true);
    expect(percentile95(individual)).toBeLessThan(1_000);
    expect(wallMs).toBeLessThan(2_500);
    console.info(JSON.stringify({
      event: 'p1.concurrent-users.certified',
      users: USERS,
      p95Ms: Number(percentile95(individual).toFixed(1)),
      wallMs: Number(wallMs.toFixed(1)),
    }));
  }, 15_000);

  it('keeps required scale indexes present and the final ledger internally consistent', async () => {
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
        'audit_at_idx',
        'attachments_created_recent_idx',
      ]],
    );
    expect(indexes.map((row) => row.indexname)).toEqual([
      'attachments_created_recent_idx',
      'audit_at_idx',
      'effects_active_target_entry_idx',
      'entries_active_account_idx',
      'entries_active_recent_idx',
      'entries_search_idx',
    ]);

    const orphaned = await db<{ n: string }>(`
      SELECT count(*) AS n
        FROM effects ef
        LEFT JOIN entries e ON e.id = ef.entry_id
       WHERE e.id IS NULL
    `);
    expect(Number(orphaned[0].n)).toBe(0);

    const transferEffectCounts = await db<{ bad: string }>(`
      SELECT count(*) AS bad
        FROM (
          SELECT e.id, count(ef.id) AS effects
            FROM entries e
            JOIN effects ef ON ef.entry_id = e.id AND ef.active = true
           WHERE e.id LIKE 'p1_transfer_%'
           GROUP BY e.id
          HAVING count(ef.id) <> 2
        ) broken
    `);
    expect(Number(transferEffectCounts[0].bad)).toBe(0);
  });
});

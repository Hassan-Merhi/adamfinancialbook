import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = 43194;
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = '2026-09-08';

const BUSINESSES = 100;
const ACCOUNTS = 1_000;
const EXPENSE_ENTRIES = 400_000;
const TRANSFER_ENTRIES = 100_000;
const TOTAL_ENTRIES = EXPENSE_ENTRIES + TRANSFER_ENTRIES;
const READ_SESSIONS = 60;
const UNIQUE_WRITES = 100;
const RECONNECT_REFS = 50;
const RECONNECT_DUPLICATES = 4;
const ENDURANCE_WAVES = 10;
const REQUESTS_PER_WAVE = 24;

let child: ReturnType<typeof spawn> | null = null;
let serverLog = '';

type Session = { cookie: string };
type TimedResponse = { response: Response; data: any; elapsedMs: number; bytes: number };

function sessionCookie(response: Response): string {
  const value = response.headers.get('set-cookie');
  if (!value) throw new Error('Expected session cookie');
  return value.split(';', 1)[0];
}

async function request(
  path: string,
  options: { method?: string; session?: Session; body?: unknown } = {},
): Promise<TimedResponse> {
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
  const started = performance.now();
  const response = await fetch(`${BASE}${path}`, { method, headers, body });
  const elapsedMs = performance.now() - started;
  const text = await response.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { response, data, elapsedMs, bytes: Buffer.byteLength(text) };
}

async function db<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: false });
  await client.connect();
  try { return (await client.query(sql, params)).rows as T[]; }
  finally { await client.end(); }
}

async function resetDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: false });
  await client.connect();
  try { await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); }
  finally { await client.end(); }
}

async function waitUntilHealthy(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child && child.exitCode !== null) throw new Error(`Server exited before health check:\n${serverLog}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch { /* starting */ }
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
      SESSION_SECRET: 'phase4-production-load-session-secret-long-enough',
      MFA_ENCRYPTION_KEY: 'phase4-production-load-mfa-key-long-enough',
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

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function assertNoServerErrors(results: TimedResponse[]): void {
  const bad = results.filter((result) => result.response.status >= 500);
  expect(bad.map((result) => ({ status: result.response.status, data: result.data }))).toEqual([]);
}

describe.skipIf(!DATABASE_URL)('Phase 4 production-scale load certification', () => {
  const owner: Session = { cookie: '' };
  const sessions: Session[] = [];
  let ownerId = '';

  beforeAll(async () => {
    await resetDatabase();
    await startServer();

    const opened = await request('/api/first-owner', {
      method: 'POST',
      body: { email: 'phase4-load-owner', password: 'Phase4LoadOwner!2026' },
    });
    expect(opened.response.status).toBe(201);
    owner.cookie = sessionCookie(opened.response);
    ownerId = opened.data.user.id as string;

    for (let index = 0; index < READ_SESSIONS - 1; index += 1) {
      const loggedIn = await request('/api/login', {
        method: 'POST',
        body: { email: 'phase4-load-owner', password: 'Phase4LoadOwner!2026' },
      });
      expect(loggedIn.response.status).toBe(200);
      sessions.push({ cookie: sessionCookie(loggedIn.response) });
    }

    await db(
      `INSERT INTO businesses (id, name, created_at)
       SELECT 'p4_biz_' || g, 'Phase 4 Business ' || g,
              TIMESTAMPTZ '2020-01-01 00:00:00+00' + (g * interval '1 second')
         FROM generate_series(1, $1::int) AS g`,
      [BUSINESSES],
    );

    await db(
      `INSERT INTO accounts (id, name, business_id, opening, created_at)
       SELECT 'p4_acc_' || g, 'Phase 4 Account ' || g,
              'p4_biz_' || (((g - 1) % $1::int) + 1),
              1000000,
              TIMESTAMPTZ '2020-01-02 00:00:00+00' + (g * interval '1 second')
         FROM generate_series(1, $2::int) AS g`,
      [BUSINESSES, ACCOUNTS],
    );

    await db(
      `INSERT INTO entries (
         id, occurred_on, kind, amount, purpose, raw, account_id, historical,
         created_by, transaction_id, created_at
       )
       SELECT 'p4_exp_' || g,
              DATE '2020-01-01' + ((g - 1) % 2400),
              'expense', 1,
              'Phase 4 expense ' || g,
              'Phase 4 expense ' || g,
              'p4_acc_' || (((g - 1) % $1::int) + 1),
              true, $2,
              'p4_tx_exp_' || g,
              TIMESTAMPTZ '2020-01-01 00:00:00+00' + (g * interval '1 second')
         FROM generate_series(1, $3::int) AS g`,
      [ACCOUNTS, ownerId, EXPENSE_ENTRIES],
    );

    await db(
      `INSERT INTO entries (
         id, occurred_on, kind, amount, purpose, raw, account_id, to_account_id,
         historical, created_by, transaction_id, created_at
       )
       SELECT 'p4_transfer_' || g,
              DATE '2020-01-01' + ((g - 1) % 2400),
              'transfer', 2,
              'Phase 4 transfer ' || g,
              'Phase 4 transfer ' || g,
              'p4_acc_' || (((g - 1) % $1::int) + 1),
              'p4_acc_' || (((g - 1 + 500) % $1::int) + 1),
              true, $2,
              'p4_tx_transfer_' || g,
              TIMESTAMPTZ '2024-01-01 00:00:00+00' + (g * interval '1 second')
         FROM generate_series(1, $3::int) AS g`,
      [ACCOUNTS, ownerId, TRANSFER_ENTRIES],
    );

    await db(
      `INSERT INTO effects (entry_id, type, target_id, delta, active)
       SELECT id, 'account', account_id, -amount, true
         FROM entries WHERE id LIKE 'p4_exp_%'`,
    );
    await db(
      `INSERT INTO effects (entry_id, type, target_id, delta, active)
       SELECT id, 'account', account_id, -amount, true
         FROM entries WHERE id LIKE 'p4_transfer_%'
       UNION ALL
       SELECT id, 'account', to_account_id, amount, true
         FROM entries WHERE id LIKE 'p4_transfer_%'`,
    );

    await db(
      `INSERT INTO audit (at, actor, actor_email, action, subject, detail)
       SELECT TIMESTAMPTZ '2020-01-01 00:00:00+00' + (g * interval '1 second'),
              $1, 'phase4-load-owner', 'phase4 load seed', 'p4_audit_' || g,
              jsonb_build_object('row', g)
         FROM generate_series(1, 100000) AS g`,
      [ownerId],
    );

    await db(
      `INSERT INTO attachments (
         id, uploaded_by, entry_id, filename, mime_type, byte_size, data, created_at
       )
       SELECT 'p4_attachment_' || g,
              $1,
              'p4_exp_' || g,
              'phase4-receipt-' || g || '.png',
              'image/png', 4, decode('89504e47', 'hex'),
              TIMESTAMPTZ '2025-01-01 00:00:00+00' + (g * interval '1 second')
         FROM generate_series(1, 25000) AS g`,
      [ownerId],
    );

    await db('ANALYZE businesses; ANALYZE accounts; ANALYZE entries; ANALYZE effects; ANALYZE audit; ANALYZE attachments;');
  }, 180_000);

  afterAll(async () => {
    await stopServer();
    if (DATABASE_URL) await resetDatabase();
  }, 30_000);

  it('certifies a 500k-entry production-shaped dataset', async () => {
    const rows = await db<{ entries: string; effects: string; audit: string; attachments: string }>(`
      SELECT
        (SELECT count(*) FROM entries WHERE id LIKE 'p4_%') AS entries,
        (SELECT count(*) FROM effects ef JOIN entries e ON e.id=ef.entry_id WHERE e.id LIKE 'p4_%') AS effects,
        (SELECT count(*) FROM audit WHERE subject LIKE 'p4_audit_%') AS audit,
        (SELECT count(*) FROM attachments WHERE id LIKE 'p4_attachment_%') AS attachments
    `);
    expect(Number(rows[0].entries)).toBe(TOTAL_ENTRIES);
    expect(Number(rows[0].effects)).toBe(EXPENSE_ENTRIES + (TRANSFER_ENTRIES * 2));
    expect(Number(rows[0].audit)).toBe(100_000);
    expect(Number(rows[0].attachments)).toBe(25_000);
  });

  it('survives 60-session mixed read contention without 5xx or queue collapse', async () => {
    const allSessions = [owner, ...sessions];
    expect(allSessions).toHaveLength(READ_SESSIONS);
    const paths = [
      '/api/overview?today=2026-09-08',
      '/api/history-page?limit=50',
      '/api/search/entries?q=Phase%204%20expense&limit=20',
      '/api/files-page?limit=40',
      '/api/statement-page?type=account&id=p4_acc_1&limit=50',
    ];
    const started = performance.now();
    const results = await Promise.all(allSessions.map((session, index) => request(paths[index % paths.length], { session })));
    const wallMs = performance.now() - started;
    assertNoServerErrors(results);
    expect(results.every((result) => result.response.status === 200)).toBe(true);
    expect(p95(results.map((result) => result.elapsedMs))).toBeLessThan(2_000);
    expect(wallMs).toBeLessThan(10_000);

    console.info(JSON.stringify({
      event: 'phase4.read-contention.certified',
      sessions: READ_SESSIONS,
      p95Ms: Number(p95(results.map((result) => result.elapsedMs)).toFixed(1)),
      wallMs: Number(wallMs.toFixed(1)),
    }));
  }, 20_000);

  it('accepts 100 concurrent financial writes exactly once with bounded latency', async () => {
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: UNIQUE_WRITES }, (_, index) => request('/api/entries', {
      method: 'POST',
      session: owner,
      body: {
        occurredOn: DAY,
        kind: 'expense',
        amount: 1,
        purpose: `Phase 4 concurrent write ${index}`,
        raw: '',
        accountId: `p4_acc_${(index % 20) + 1}`,
        clientRef: `phase4-concurrent-${index}`,
      },
    })));
    const wallMs = performance.now() - started;
    assertNoServerErrors(results);
    expect(results.every((result) => result.response.status === 201)).toBe(true);
    expect(p95(results.map((result) => result.elapsedMs))).toBeLessThan(2_500);
    expect(wallMs).toBeLessThan(12_000);

    const counts = await db<{ entries: string; effects: string }>(`
      SELECT
        (SELECT count(*) FROM entries WHERE client_ref LIKE 'phase4-concurrent-%') AS entries,
        (SELECT count(*) FROM effects ef JOIN entries e ON e.id=ef.entry_id WHERE e.client_ref LIKE 'phase4-concurrent-%' AND ef.active=true) AS effects
    `);
    expect(Number(counts[0].entries)).toBe(UNIQUE_WRITES);
    expect(Number(counts[0].effects)).toBe(UNIQUE_WRITES);
  }, 25_000);

  it('absorbs a 200-request reconnect retry storm without duplicate money movement', async () => {
    const requests: Promise<TimedResponse>[] = [];
    for (let ref = 0; ref < RECONNECT_REFS; ref += 1) {
      for (let duplicate = 0; duplicate < RECONNECT_DUPLICATES; duplicate += 1) {
        requests.push(request('/api/entries', {
          method: 'POST',
          session: owner,
          body: {
            occurredOn: DAY,
            kind: 'expense',
            amount: 2,
            purpose: `Phase 4 reconnect ${ref}`,
            raw: '',
            accountId: `p4_acc_${(ref % 10) + 1}`,
            clientRef: `phase4-reconnect-${ref}`,
          },
        }));
      }
    }
    const started = performance.now();
    const results = await Promise.all(requests);
    const wallMs = performance.now() - started;
    assertNoServerErrors(results);
    expect(results.every((result) => result.response.status === 201)).toBe(true);
    expect(p95(results.map((result) => result.elapsedMs))).toBeLessThan(3_000);
    expect(wallMs).toBeLessThan(15_000);

    const counts = await db<{ entries: string; effects: string; refs: string }>(`
      SELECT
        count(*) AS entries,
        count(DISTINCT client_ref) AS refs,
        (SELECT count(*) FROM effects ef JOIN entries e2 ON e2.id=ef.entry_id
          WHERE e2.client_ref LIKE 'phase4-reconnect-%' AND ef.active=true) AS effects
        FROM entries
       WHERE client_ref LIKE 'phase4-reconnect-%'
    `);
    expect(Number(counts[0].entries)).toBe(RECONNECT_REFS);
    expect(Number(counts[0].refs)).toBe(RECONNECT_REFS);
    expect(Number(counts[0].effects)).toBe(RECONNECT_REFS);
  }, 30_000);

  it('survives repeated mixed-load endurance waves and returns to healthy readiness', async () => {
    const latencies: number[] = [];
    for (let wave = 0; wave < ENDURANCE_WAVES; wave += 1) {
      const results = await Promise.all(Array.from({ length: REQUESTS_PER_WAVE }, (_, index) => {
        const session = index % 2 === 0 ? owner : sessions[index % sessions.length];
        const path = index % 3 === 0
          ? `/api/statement-page?type=account&id=p4_acc_${(index % 40) + 1}&limit=25`
          : index % 3 === 1
            ? '/api/history-page?limit=25'
            : '/api/overview?today=2026-09-08';
        return request(path, { session });
      }));
      assertNoServerErrors(results);
      expect(results.every((result) => result.response.status === 200)).toBe(true);
      latencies.push(...results.map((result) => result.elapsedMs));
    }

    expect(p95(latencies)).toBeLessThan(2_000);
    const ready = await request('/api/health/ready');
    expect(ready.response.status).toBe(200);
    expect(ready.data.ok).toBe(true);
    expect(ready.data.pool.waiting).toBe(0);

    console.info(JSON.stringify({
      event: 'phase4.endurance.certified',
      waves: ENDURANCE_WAVES,
      requests: ENDURANCE_WAVES * REQUESTS_PER_WAVE,
      p95Ms: Number(p95(latencies).toFixed(1)),
      pool: ready.data.pool,
    }));
  }, 60_000);

  it('finishes with an internally consistent ledger and conserved transfer effects', async () => {
    const orphaned = await db<{ n: string }>(`
      SELECT count(*) AS n
        FROM effects ef
        LEFT JOIN entries e ON e.id=ef.entry_id
       WHERE e.id IS NULL
    `);
    expect(Number(orphaned[0].n)).toBe(0);

    const duplicateRefs = await db<{ n: string }>(`
      SELECT count(*) AS n FROM (
        SELECT client_ref
          FROM entries
         WHERE client_ref LIKE 'phase4-%'
         GROUP BY client_ref
        HAVING count(*) > 1
      ) duplicates
    `);
    expect(Number(duplicateRefs[0].n)).toBe(0);

    const transferConservation = await db<{ delta: string }>(`
      SELECT COALESCE(sum(ef.delta), 0)::text AS delta
        FROM effects ef
        JOIN entries e ON e.id=ef.entry_id
       WHERE e.id LIKE 'p4_transfer_%'
         AND ef.active=true
    `);
    expect(Number(transferConservation[0].delta)).toBe(0);

    const badTransferEffects = await db<{ n: string }>(`
      SELECT count(*) AS n FROM (
        SELECT e.id
          FROM entries e
          JOIN effects ef ON ef.entry_id=e.id AND ef.active=true
         WHERE e.id LIKE 'p4_transfer_%'
         GROUP BY e.id
        HAVING count(*) <> 2 OR sum(ef.delta) <> 0
      ) bad
    `);
    expect(Number(badTransferEffects[0].n)).toBe(0);

    console.info(JSON.stringify({
      event: 'phase4.production-load.certified',
      datasetEntries: TOTAL_ENTRIES,
      concurrentReadSessions: READ_SESSIONS,
      concurrentWrites: UNIQUE_WRITES,
      reconnectRequests: RECONNECT_REFS * RECONNECT_DUPLICATES,
      reconnectUniqueWrites: RECONNECT_REFS,
      enduranceRequests: ENDURANCE_WAVES * REQUESTS_PER_WAVE,
    }));
  });
});

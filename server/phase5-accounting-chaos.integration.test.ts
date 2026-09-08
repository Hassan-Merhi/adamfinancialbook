import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = 43195;
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = '2026-09-08';
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

async function resetDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: false });
  await client.connect();
  try { await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); }
  finally { await client.end(); }
}

async function waitUntilHealthy(): Promise<void> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child && child.exitCode !== null) throw new Error(`Server exited before health check:\n${serverLog}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server never became healthy:\n${serverLog}`);
}

function offlineContext(accountId: string, businessId: string, balance: number) {
  return {
    version: 1,
    capturedAt: '2026-09-08T08:00:00.000Z',
    sourceAccount: { id: accountId, businessId, balance },
    destinationAccount: null,
    project: null,
    person: null,
    receipt: null,
  };
}

function transferContext(
  sourceId: string,
  businessId: string,
  sourceBalance: number,
  destinationId: string,
  destinationBalance: number,
) {
  return {
    ...offlineContext(sourceId, businessId, sourceBalance),
    destinationAccount: { id: destinationId, businessId, balance: destinationBalance },
  };
}

describe.skipIf(!DATABASE_URL)('Phase 5 accounting chaos certification', () => {
  const ownerA: Session = { cookie: '' };
  const ownerB: Session = { cookie: '' };
  let ownerAId = '';
  let ownerBId = '';
  let businessId = '';

  const createAccount = async (name: string, opening: number) => {
    const created = await request('/api/accounts', {
      method: 'POST', session: ownerA, body: { name, businessId, opening },
    });
    expect(created.response.status).toBe(201);
    return created.data.id as string;
  };

  beforeAll(async () => {
    await resetDatabase();
    child = spawn(process.execPath, ['--import', 'tsx', 'server/start.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: DATABASE_URL!,
        SESSION_SECRET: 'phase5-accounting-chaos-session-secret-long-enough',
        MFA_ENCRYPTION_KEY: 'phase5-accounting-chaos-mfa-key-long-enough',
        PGSSL: 'off',
        PGPOOL_MAX: '10',
        PORT: String(PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => { serverLog += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { serverLog += chunk.toString(); });
    await waitUntilHealthy();

    const first = await request('/api/first-owner', {
      method: 'POST', body: { email: 'phase5-chaos-owner-a', password: 'Phase5OwnerA!2026' },
    });
    expect(first.response.status).toBe(201);
    ownerA.cookie = sessionCookie(first.response);
    ownerAId = first.data.user.id as string;

    const second = await request('/api/users', {
      method: 'POST', session: ownerA,
      body: { email: 'phase5-chaos-owner-b', password: 'Phase5OwnerB!2026', role: 'owner' },
    });
    expect(second.response.status).toBe(201);
    ownerBId = second.data.user.id as string;
    const secondLogin = await request('/api/login', {
      method: 'POST', body: { email: 'phase5-chaos-owner-b', password: 'Phase5OwnerB!2026' },
    });
    expect(secondLogin.response.status).toBe(200);
    ownerB.cookie = sessionCookie(secondLogin.response);

    const business = await request('/api/businesses', {
      method: 'POST', session: ownerA, body: { name: 'Phase 5 Chaos Business' },
    });
    expect(business.response.status).toBe(201);
    businessId = business.data.id as string;
  }, 30_000);

  afterAll(async () => {
    const running = child;
    if (running && running.exitCode === null) {
      running.kill('SIGTERM');
      await Promise.race([once(running, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (running.exitCode === null) running.kill('SIGKILL');
    }
    if (DATABASE_URL) await resetDatabase();
  }, 20_000);

  it('deduplicates a 40-request financial retry storm to one ledger movement', async () => {
    const cash = await createAccount('Chaos Duplicate Cash', 1000);
    const payload = {
      occurredOn: DAY,
      kind: 'expense',
      amount: 25,
      purpose: 'Forty retry storm',
      raw: 'Forty retry storm',
      accountId: cash,
      clientRef: 'phase5_retry_storm',
    };
    const results = await Promise.all(Array.from({ length: 40 }, () =>
      request('/api/entries', { method: 'POST', session: ownerA, body: payload })));

    expect(results.every(({ response }) => response.status === 200 || response.status === 201)).toBe(true);
    expect(new Set(results.map(({ data }) => data.id)).size).toBe(1);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM entries WHERE client_ref = 'phase5_retry_storm'`,
    ))[0].n)).toBe(1);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM effects ef JOIN entries e ON e.id = ef.entry_id
        WHERE e.client_ref = 'phase5_retry_storm' AND ef.active = true`,
    ))[0].n)).toBe(1);

    const book = await request('/api/book', { session: ownerA });
    expect(book.data.balances.accounts[cash]).toBe(975);
  }, 20_000);

  it('survives create → correct → correct → void without residue or lost audit history', async () => {
    const cash = await createAccount('Correction Chain Cash', 1000);
    const created = await request('/api/entries', {
      method: 'POST', session: ownerA,
      body: { occurredOn: DAY, kind: 'expense', amount: 100, purpose: 'Correction chain', raw: '', accountId: cash, clientRef: 'phase5_chain' },
    });
    expect(created.response.status).toBe(201);
    const id = created.data.id as string;

    expect((await request(`/api/entries/${id}`, {
      method: 'PATCH', session: ownerA, body: { amount: 80 },
    })).response.status).toBe(200);
    expect((await request(`/api/entries/${id}`, {
      method: 'PATCH', session: ownerB, body: { amount: 60 },
    })).response.status).toBe(200);
    expect((await request(`/api/entries/${id}/void`, {
      method: 'POST', session: ownerA, body: { reason: 'Phase 5 chaos void' },
    })).response.status).toBe(200);

    const row = (await db<{ amount: string; voided_at: Date | null }>(
      'SELECT amount, voided_at FROM entries WHERE id = $1', [id],
    ))[0];
    expect(Number(row.amount)).toBe(60);
    expect(row.voided_at).not.toBeNull();
    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM effects WHERE entry_id = $1 AND active = true', [id],
    ))[0].n)).toBe(0);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM entry_revisions WHERE entry_id = $1 AND revision_type = 'correction'`, [id],
    ))[0].n)).toBe(2);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM entry_revisions WHERE entry_id = $1 AND revision_type = 'void'`, [id],
    ))[0].n)).toBe(1);

    const book = await request('/api/book', { session: ownerA });
    expect(book.data.balances.accounts[cash]).toBe(1000);
  });

  it('serializes concurrent corrections without duplicate active accounting effects', async () => {
    const cash = await createAccount('Concurrent Correction Cash', 1000);
    const created = await request('/api/entries', {
      method: 'POST', session: ownerA,
      body: { occurredOn: DAY, kind: 'expense', amount: 100, purpose: 'Concurrent correction', raw: '', accountId: cash, clientRef: 'phase5_concurrent_correction' },
    });
    const id = created.data.id as string;

    const [a, b] = await Promise.all([
      request(`/api/entries/${id}`, { method: 'PATCH', session: ownerA, body: { amount: 70 } }),
      request(`/api/entries/${id}`, { method: 'PATCH', session: ownerB, body: { amount: 50 } }),
    ]);
    expect([200, 409]).toContain(a.response.status);
    expect([200, 409]).toContain(b.response.status);
    expect([a, b].filter((result) => result.response.status === 200).length).toBeGreaterThanOrEqual(1);

    const row = (await db<{ amount: string }>('SELECT amount FROM entries WHERE id = $1', [id]))[0];
    const active = await db<{ delta: string }>(
      `SELECT delta FROM effects WHERE entry_id = $1 AND active = true AND type = 'account'`, [id],
    );
    expect(active).toHaveLength(1);
    expect(Number(active[0].delta)).toBe(-Number(row.amount));
    expect([50, 70]).toContain(Number(row.amount));

    const revisions = Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM entry_revisions WHERE entry_id = $1 AND revision_type = 'correction'`, [id],
    ))[0].n);
    expect(revisions).toBe([a, b].filter((result) => result.response.status === 200).length);
  });

  it('survives correction racing void and always finishes voided with zero active effects', async () => {
    const cash = await createAccount('Correction Void Race Cash', 1000);
    const created = await request('/api/entries', {
      method: 'POST', session: ownerA,
      body: { occurredOn: DAY, kind: 'expense', amount: 120, purpose: 'Correction void race', raw: '', accountId: cash, clientRef: 'phase5_correction_void' },
    });
    const id = created.data.id as string;

    const [correction, voided] = await Promise.all([
      request(`/api/entries/${id}`, { method: 'PATCH', session: ownerA, body: { amount: 90 } }),
      request(`/api/entries/${id}/void`, { method: 'POST', session: ownerB, body: { reason: 'Concurrent void wins final state' } }),
    ]);
    expect([200, 409]).toContain(correction.response.status);
    expect(voided.response.status).toBe(200);

    const row = (await db<{ voided_at: Date | null }>('SELECT voided_at FROM entries WHERE id = $1', [id]))[0];
    expect(row.voided_at).not.toBeNull();
    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM effects WHERE entry_id = $1 AND active = true', [id],
    ))[0].n)).toBe(0);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM entry_revisions WHERE entry_id = $1 AND revision_type = 'void'`, [id],
    ))[0].n)).toBe(1);

    const book = await request('/api/book', { session: ownerA });
    expect(book.data.balances.accounts[cash]).toBe(1000);
  });

  it('rejects a stale offline spend after an online mutation changes the captured balance', async () => {
    const cash = await createAccount('Stale Offline Cash', 100);
    expect((await request('/api/entries', {
      method: 'POST', session: ownerA,
      body: { occurredOn: DAY, kind: 'expense', amount: 60, purpose: 'Online spend first', raw: '', accountId: cash, clientRef: 'phase5_online_first' },
    })).response.status).toBe(201);

    const stale = await request('/api/entries', {
      method: 'POST', session: ownerA,
      body: {
        occurredOn: DAY, kind: 'expense', amount: 70, purpose: 'Stale offline replay', raw: '',
        accountId: cash, clientRef: 'phase5_stale_offline',
        offlineContext: offlineContext(cash, businessId, 100),
      },
    });
    expect(stale.response.status).toBe(409);
    expect(['OFFLINE_CONFLICT_STALE_BALANCE', 'OFFLINE_CONFLICT_INSUFFICIENT_FUNDS']).toContain(stale.data.code);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM entries WHERE client_ref = 'phase5_stale_offline'`,
    ))[0].n)).toBe(0);

    const book = await request('/api/book', { session: ownerA });
    expect(book.data.balances.accounts[cash]).toBe(40);
  });

  it('rejects a queued delegated write after the user is disabled and preserves existing history', async () => {
    const cash = await createAccount('Disabled Replay Cash', 200);
    const createdUser = await request('/api/users', {
      method: 'POST', session: ownerA,
      body: { email: 'phase5-disabled-user', password: 'Phase5Disabled!2026', role: 'entry' },
    });
    expect(createdUser.response.status).toBe(201);
    const userId = createdUser.data.user.id as string;
    expect((await request(`/api/delegation/users/${userId}/accounts`, {
      method: 'PUT', session: ownerA, body: { accountIds: [cash] },
    })).response.status).toBe(200);
    const login = await request('/api/login', {
      method: 'POST', body: { email: 'phase5-disabled-user', password: 'Phase5Disabled!2026' },
    });
    const delegate: Session = { cookie: sessionCookie(login.response) };

    const before = await request('/api/entries', {
      method: 'POST', session: delegate,
      body: { occurredOn: DAY, kind: 'expense', amount: 10, purpose: 'History survives disable', raw: '', accountId: cash, clientRef: 'phase5_before_disable' },
    });
    expect(before.response.status).toBe(201);

    expect((await request(`/api/users/${userId}`, { method: 'DELETE', session: ownerA, body: {} })).response.status).toBe(200);
    const replay = await request('/api/entries', {
      method: 'POST', session: delegate,
      body: {
        occurredOn: DAY, kind: 'expense', amount: 20, purpose: 'Must not post after disable', raw: '',
        accountId: cash, clientRef: 'phase5_after_disable', offlineContext: offlineContext(cash, businessId, 190),
      },
    });
    expect(replay.response.status).toBe(401);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM entries WHERE client_ref = 'phase5_after_disable'`,
    ))[0].n)).toBe(0);
    expect((await db<{ created_by: string }>('SELECT created_by FROM entries WHERE id = $1', [before.data.id]))[0].created_by).toBe(userId);
  });

  it('deduplicates repeated transfer delivery and conserves both accounts exactly', async () => {
    const source = await createAccount('Transfer Replay Source', 500);
    const destination = await createAccount('Transfer Replay Destination', 100);
    const payload = {
      occurredOn: DAY,
      kind: 'transfer',
      amount: 125,
      purpose: 'Transfer retry storm',
      raw: '',
      accountId: source,
      toAccountId: destination,
      clientRef: 'phase5_transfer_retry',
      offlineContext: transferContext(source, businessId, 500, destination, 100),
    };
    const results = await Promise.all(Array.from({ length: 25 }, () =>
      request('/api/entries', { method: 'POST', session: ownerA, body: payload })));
    expect(results.every(({ response }) => response.status === 200 || response.status === 201)).toBe(true);
    expect(new Set(results.map(({ data }) => data.id)).size).toBe(1);

    const entryId = results[0].data.id as string;
    const effects = await db<{ delta: string }>(
      `SELECT delta FROM effects WHERE entry_id = $1 AND active = true AND type = 'account' ORDER BY id`, [entryId],
    );
    expect(effects).toHaveLength(2);
    expect(effects.reduce((sum, row) => sum + Number(row.delta), 0)).toBe(0);

    const book = await request('/api/book', { session: ownerA });
    expect(book.data.balances.accounts[source]).toBe(375);
    expect(book.data.balances.accounts[destination]).toBe(225);
  }, 20_000);

  it('finishes with global accounting invariants intact after every chaos scenario', async () => {
    expect(Number((await db<{ n: string }>(`
      SELECT count(*) AS n
        FROM effects ef
        LEFT JOIN entries e ON e.id = ef.entry_id
       WHERE e.id IS NULL
    `))[0].n)).toBe(0);

    expect(Number((await db<{ n: string }>(`
      SELECT count(*) AS n
        FROM effects ef
        JOIN entries e ON e.id = ef.entry_id
       WHERE e.voided_at IS NOT NULL AND ef.active = true
    `))[0].n)).toBe(0);

    expect(Number((await db<{ n: string }>(`
      SELECT count(*) AS n FROM (
        SELECT e.id, count(ef.id) AS effect_count, COALESCE(sum(ef.delta), 0) AS net
          FROM entries e
          JOIN effects ef ON ef.entry_id = e.id AND ef.active = true AND ef.type = 'account'
         WHERE e.kind = 'transfer' AND e.voided_at IS NULL
         GROUP BY e.id
        HAVING count(ef.id) <> 2 OR COALESCE(sum(ef.delta), 0) <> 0
      ) broken
    `))[0].n)).toBe(0);

    expect(Number((await db<{ n: string }>(`
      SELECT count(*) AS n FROM (
        SELECT client_ref FROM entries
         WHERE client_ref IS NOT NULL
         GROUP BY client_ref HAVING count(*) > 1
      ) duplicated
    `))[0].n)).toBe(0);

    const actors = await db<{ id: string }>('SELECT id FROM users WHERE id = ANY($1::text[])', [[ownerAId, ownerBId]]);
    expect(actors).toHaveLength(2);
  });
});

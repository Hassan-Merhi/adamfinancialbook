import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = 43175;
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = '2026-09-06';
let child: ReturnType<typeof spawn> | null = null;
let serverLog = '';

type Session = { cookie: string };
type Delegate = { id: string; username: string; password: string; session: Session };

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
  for (let index = 0; index < 150; index += 1) {
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
    capturedAt: '2026-09-06T09:00:00.000Z',
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

describe.skipIf(!DATABASE_URL)('Phase 7 reconnect / chaos / multi-device PostgreSQL certification', () => {
  const owner: Session = { cookie: '' };
  let business = '';
  let userA: Delegate;
  let userB: Delegate;

  const createAccount = async (name: string, opening: number): Promise<string> => {
    const created = await request('/api/accounts', {
      method: 'POST', session: owner, body: { name, businessId: business, opening },
    });
    expect(created.response.status).toBe(201);
    return created.data.id as string;
  };

  const setAccess = async (userId: string, accountIds: string[]) => {
    const result = await request(`/api/delegation/users/${userId}/accounts`, {
      method: 'PUT', session: owner, body: { accountIds },
    });
    expect(result.response.status).toBe(200);
  };

  const createDelegate = async (username: string, password: string): Promise<Delegate> => {
    const created = await request('/api/users', {
      method: 'POST', session: owner, body: { email: username, password, role: 'entry' },
    });
    expect(created.response.status).toBe(201);
    const login = await request('/api/login', { method: 'POST', body: { email: username, password } });
    expect(login.response.status).toBe(200);
    return {
      id: created.data.user.id as string,
      username,
      password,
      session: { cookie: sessionCookie(login.response) },
    };
  };

  beforeAll(async () => {
    await resetToLegacyShape();
    child = spawn(process.execPath, ['--import', 'tsx', 'server/start.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: DATABASE_URL!,
        SESSION_SECRET: 'offline-phase-7-chaos-secret-long-enough',
        PGSSL: 'off',
        PGPOOL_MAX: '8',
        PORT: String(PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => { serverLog += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { serverLog += chunk.toString(); });
    await waitUntilHealthy();

    const opened = await request('/api/first-owner', {
      method: 'POST', body: { email: 'phase7-owner', password: 'OwnerPass!2026' },
    });
    expect(opened.response.status).toBe(201);
    owner.cookie = sessionCookie(opened.response);

    const createdBusiness = await request('/api/businesses', {
      method: 'POST', session: owner, body: { name: 'Phase 7 Chaos Business' },
    });
    expect(createdBusiness.response.status).toBe(201);
    business = createdBusiness.data.id as string;

    userA = await createDelegate('phase7-device-a', 'DelegateA!2026');
    userB = await createDelegate('phase7-device-b', 'DelegateB!2026');
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

  it('survives a duplicate-response/reconnect storm with one logical server entry', async () => {
    const cash = await createAccount('Replay Storm Cash', 1000);
    const body = {
      occurredOn: DAY,
      kind: 'expense',
      amount: 10,
      purpose: 'Phase 7 replay storm',
      raw: 'Phase 7 replay storm',
      accountId: cash,
      clientRef: 'q_phase7_replay_storm',
      offlineContext: offlineContext(cash, business, 1000),
    };

    const responses = await Promise.all(Array.from({ length: 40 }, () =>
      request('/api/entries', { method: 'POST', session: owner, body })));

    expect(responses.every(({ response }) => response.status === 200 || response.status === 201)).toBe(true);
    expect(responses.filter(({ response }) => response.status === 201)).toHaveLength(1);
    expect(new Set(responses.map(({ data }) => data.id)).size).toBe(1);
    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM entries WHERE client_ref = $1', ['q_phase7_replay_storm'],
    ))[0].n)).toBe(1);

    const book = await request('/api/book', { session: owner });
    expect(book.data.balances.accounts[cash]).toBe(990);
  }, 20_000);

  it('serializes two different users spending the same stale account so only one can post', async () => {
    const shared = await createAccount('Shared Multi User Cash', 100);
    await setAccess(userA.id, [shared]);
    await setAccess(userB.id, [shared]);

    const body = (clientRef: string) => ({
      occurredOn: DAY,
      kind: 'expense',
      amount: 70,
      purpose: clientRef,
      raw: clientRef,
      accountId: shared,
      clientRef,
      offlineContext: offlineContext(shared, business, 100),
    });

    const [a, b] = await Promise.all([
      request('/api/entries', { method: 'POST', session: userA.session, body: body('q_phase7_user_a') }),
      request('/api/entries', { method: 'POST', session: userB.session, body: body('q_phase7_user_b') }),
    ]);

    expect([a.response.status, b.response.status].sort()).toEqual([201, 409]);
    const failed = a.response.status === 409 ? a : b;
    expect(['OFFLINE_CONFLICT_STALE_BALANCE', 'OFFLINE_CONFLICT_INSUFFICIENT_FUNDS']).toContain(failed.data.code);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM entries WHERE client_ref IN ('q_phase7_user_a','q_phase7_user_b')`,
    ))[0].n)).toBe(1);

    const book = await request('/api/book', { session: owner });
    expect(book.data.balances.accounts[shared]).toBe(30);
  });

  it('serializes conflicting transfers and conserves the source/destination total', async () => {
    const source = await createAccount('Transfer Source', 200);
    const destinationA = await createAccount('Transfer Destination A', 0);
    const destinationB = await createAccount('Transfer Destination B', 0);
    await setAccess(userA.id, [source, destinationA, destinationB]);
    await setAccess(userB.id, [source, destinationA, destinationB]);

    const body = (clientRef: string, destination: string) => ({
      occurredOn: DAY,
      kind: 'transfer',
      amount: 150,
      purpose: clientRef,
      raw: clientRef,
      accountId: source,
      toAccountId: destination,
      clientRef,
      offlineContext: transferContext(source, business, 200, destination, 0),
    });

    const [a, b] = await Promise.all([
      request('/api/entries', {
        method: 'POST', session: userA.session, body: body('q_phase7_transfer_a', destinationA),
      }),
      request('/api/entries', {
        method: 'POST', session: userB.session, body: body('q_phase7_transfer_b', destinationB),
      }),
    ]);

    expect([a.response.status, b.response.status].sort()).toEqual([201, 409]);
    const failed = a.response.status === 409 ? a : b;
    expect(['OFFLINE_CONFLICT_STALE_BALANCE', 'OFFLINE_CONFLICT_INSUFFICIENT_FUNDS']).toContain(failed.data.code);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM entries WHERE client_ref IN ('q_phase7_transfer_a','q_phase7_transfer_b')`,
    ))[0].n)).toBe(1);

    const book = await request('/api/book', { session: owner });
    const sourceBalance = Number(book.data.balances.accounts[source]);
    const aBalance = Number(book.data.balances.accounts[destinationA]);
    const bBalance = Number(book.data.balances.accounts[destinationB]);
    expect(sourceBalance).toBe(50);
    expect(aBalance + bBalance).toBe(150);
    expect(sourceBalance + aBalance + bBalance).toBe(200);
  });

  it('prevents a password-revoked offline session from posting, then allows a fresh login', async () => {
    const cash = await createAccount('Revoked Session Cash', 100);
    await setAccess(userB.id, [cash]);
    const oldSession = { ...userB.session };

    const changed = await request(`/api/users/${userB.id}/password`, {
      method: 'POST', session: owner, body: { password: 'DelegateB-New!2026' },
    });
    expect(changed.response.status).toBe(200);

    const blocked = await request('/api/entries', {
      method: 'POST', session: oldSession,
      body: {
        occurredOn: DAY,
        kind: 'expense',
        amount: 10,
        purpose: 'Queued before password reset',
        raw: 'Queued before password reset',
        accountId: cash,
        clientRef: 'q_phase7_revoked_session',
        offlineContext: offlineContext(cash, business, 100),
      },
    });
    expect(blocked.response.status).toBe(401);
    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM entries WHERE client_ref = $1', ['q_phase7_revoked_session'],
    ))[0].n)).toBe(0);

    const login = await request('/api/login', {
      method: 'POST', body: { email: userB.username, password: 'DelegateB-New!2026' },
    });
    expect(login.response.status).toBe(200);
    userB = { ...userB, password: 'DelegateB-New!2026', session: { cookie: sessionCookie(login.response) } };
  });

  it('prevents a disabled user from posting anything queued while offline', async () => {
    const cash = await createAccount('Disabled User Cash', 100);
    await setAccess(userA.id, [cash]);
    const oldSession = { ...userA.session };

    const disabled = await request(`/api/users/${userA.id}`, { method: 'DELETE', session: owner, body: {} });
    expect(disabled.response.status).toBe(200);

    const blocked = await request('/api/entries', {
      method: 'POST', session: oldSession,
      body: {
        occurredOn: DAY,
        kind: 'expense',
        amount: 10,
        purpose: 'Queued before user disable',
        raw: 'Queued before user disable',
        accountId: cash,
        clientRef: 'q_phase7_disabled_user',
        offlineContext: offlineContext(cash, business, 100),
      },
    });
    expect(blocked.response.status).toBe(401);
    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM entries WHERE client_ref = $1', ['q_phase7_disabled_user'],
    ))[0].n)).toBe(0);
  });

  it('finishes the stress run with unique idempotency keys and a green database integrity check', () => {
    const duplicates = spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', `
        import pg from 'pg';
        const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
        await c.connect();
        const r = await c.query("SELECT client_ref, count(*) AS n FROM entries WHERE client_ref IS NOT NULL GROUP BY client_ref HAVING count(*) > 1");
        console.log(JSON.stringify(r.rows));
        await c.end();
      `],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: DATABASE_URL!, PGSSL: 'off' },
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    expect(duplicates.status, duplicates.stderr).toBe(0);
    expect(JSON.parse(duplicates.stdout.trim())).toEqual([]);

    const integrity = spawnSync(process.execPath, ['--import', 'tsx', 'server/integrity-check.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: DATABASE_URL!, PGSSL: 'off' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(integrity.status, `${integrity.stdout}\n${integrity.stderr}`).toBe(0);
    const result = JSON.parse(integrity.stdout.trim()) as { ok: boolean; errors: number };
    expect(result.ok).toBe(true);
    expect(result.errors).toBe(0);
  }, 40_000);
});

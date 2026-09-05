import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = 43127;
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = '2026-09-05';
let server: ReturnType<typeof spawn> | null = null;
let serverLog = '';

type Session = { cookie: string };
type JsonResult = { response: Response; data: any };

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (!header) throw new Error('Expected a session cookie');
  return header.split(';', 1)[0];
}

async function json(
  path: string,
  options: { method?: string; session?: Session; body?: unknown } = {},
): Promise<JsonResult> {
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

async function rows<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL, ssl: false });
  await client.connect();
  try { return (await client.query(sql, params)).rows as T[]; }
  finally { await client.end(); }
}

async function resetLegacyDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL, ssl: false });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    // Reproduce the old production users table that lacked language/token_version.
    await client.query(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  } finally {
    await client.end();
  }
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (server && server.exitCode !== null) throw new Error(`Server exited early:\n${serverLog}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch { /* startup in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy:\n${serverLog}`);
}

describe.skipIf(!TEST_DATABASE_URL)('PostgreSQL production workflows', () => {
  const owner: Session = { cookie: '' };
  const delegate: Session = { cookie: '' };
  const otherDelegate: Session = { cookie: '' };
  let ownerId = '';
  let delegateId = '';
  let otherDelegateId = '';
  let businessA = '';
  let businessB = '';
  let ownerCash = '';
  let wallet = '';
  let businessBCash = '';
  let supplier = '';
  let borrower = '';
  let employee = '';
  let project = '';
  let spendEntry = '';
  let approval = '';
  let attachment = '';

  beforeAll(async () => {
    await resetLegacyDatabase();
    server = spawn(process.execPath, ['--import', 'tsx', 'server/start.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: TEST_DATABASE_URL!,
        SESSION_SECRET: 'phase-3-integration-secret-that-is-long-enough',
        PGSSL: 'off',
        PGPOOL_MAX: '4',
        PORT: String(PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (chunk) => { serverLog += chunk.toString(); });
    server.stderr?.on('data', (chunk) => { serverLog += chunk.toString(); });
    await waitForHealth();
  }, 30_000);

  afterAll(async () => {
    const child = server;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    if (TEST_DATABASE_URL) {
      const client = new pg.Client({ connectionString: TEST_DATABASE_URL, ssl: false });
      await client.connect();
      try { await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); }
      finally { await client.end(); }
    }
  }, 15_000);

  it('migrates a legacy database before traffic and bootstraps exactly one owner', async () => {
    const applied = await rows<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    expect(applied.map((x) => Number(x.version))).toEqual([1]);
    const columns = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users'`,
    );
    expect(columns.map((x) => x.column_name)).toEqual(expect.arrayContaining(['language', 'token_version']));

    expect((await json('/api/book')).response.status).toBe(401);
    expect((await json('/api/me')).data.needsFirstOwner).toBe(true);

    const opened = await json('/api/first-owner', {
      method: 'POST', body: { email: 'owner@example.com', password: 'OwnerPass!2026' },
    });
    expect(opened.response.status).toBe(201);
    owner.cookie = cookieFrom(opened.response);
    ownerId = opened.data.user.id;

    expect((await json('/api/first-owner', {
      method: 'POST', body: { email: 'attacker@example.com', password: 'AttackPass!2026' },
    })).response.status).toBe(403);
  });

  it('sets up the book and enforces delegated account ownership', async () => {
    const a = await json('/api/businesses', { method: 'POST', session: owner, body: { name: 'Alpha Construction' } });
    const b = await json('/api/businesses', { method: 'POST', session: owner, body: { name: 'Beta Trading' } });
    businessA = a.data.id; businessB = b.data.id;

    ownerCash = (await json('/api/accounts', {
      method: 'POST', session: owner, body: { name: 'Owner Cash', businessId: businessA, opening: 5000 },
    })).data.id;
    wallet = (await json('/api/accounts', {
      method: 'POST', session: owner, body: { name: 'Delegate Wallet', businessId: businessA, opening: 0 },
    })).data.id;
    businessBCash = (await json('/api/accounts', {
      method: 'POST', session: owner, body: { name: 'Beta Cash', businessId: businessB, opening: 1000 },
    })).data.id;
    project = (await json('/api/projects', {
      method: 'POST', session: owner, body: { name: 'Warehouse', scope: 'Construction', businessId: businessA, opening: 0 },
    })).data.id;
    supplier = (await json('/api/people', {
      method: 'POST', session: owner,
      body: { name: 'Steel Supplier', businessId: businessA, opening: 0, kind: 'payable', role: 'Supplier', salary: 0 },
    })).data.id;
    borrower = (await json('/api/people', {
      method: 'POST', session: owner,
      body: { name: 'Borrower', businessId: businessA, opening: 0, kind: 'receivable', role: 'Loan', salary: 0 },
    })).data.id;
    employee = (await json('/api/people', {
      method: 'POST', session: owner,
      body: { name: 'Worker', businessId: businessA, opening: 0, kind: 'salary', role: 'Staff', salary: 100 },
    })).data.id;

    const user1 = await json('/api/users', {
      method: 'POST', session: owner,
      body: { email: 'delegate@example.com', password: 'DelegatePass!2026', role: 'entry' },
    });
    const user2 = await json('/api/users', {
      method: 'POST', session: owner,
      body: { email: 'delegate2@example.com', password: 'Delegate2Pass!2026', role: 'entry' },
    });
    delegateId = user1.data.user.id; otherDelegateId = user2.data.user.id;

    expect((await json(`/api/delegation/users/${delegateId}/accounts`, {
      method: 'PUT', session: owner, body: { accountIds: [wallet] },
    })).response.status).toBe(200);
    expect((await json(`/api/delegation/users/${otherDelegateId}/accounts`, {
      method: 'PUT', session: owner, body: { accountIds: [wallet] },
    })).response.status).toBe(409);

    const login1 = await json('/api/login', {
      method: 'POST', body: { email: 'delegate@example.com', password: 'DelegatePass!2026' },
    });
    const login2 = await json('/api/login', {
      method: 'POST', body: { email: 'delegate2@example.com', password: 'Delegate2Pass!2026' },
    });
    delegate.cookie = cookieFrom(login1.response); otherDelegate.cookie = cookieFrom(login2.response);

    const delegatedBook = await json('/api/book', { session: delegate });
    expect(delegatedBook.data.accounts.map((x: any) => x.id)).toEqual([wallet]);
    expect(delegatedBook.data.businesses.map((x: any) => x.id)).toEqual([businessA]);
    expect((await json('/api/book', { session: otherDelegate })).data.accounts).toHaveLength(0);
    expect((await json('/api/businesses', { method: 'POST', session: delegate, body: { name: 'Forbidden' } })).response.status).toBe(403);
    expect((await json(`/api/statement?type=account&id=${ownerCash}`, { session: delegate })).response.status).toBe(403);
  });

  it('requires delegated handoff confirmation, prevents overdrafts, and deduplicates concurrent spending', async () => {
    expect((await json('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'transfer', amount: 500, purpose: 'Direct', raw: '', accountId: ownerCash, toAccountId: wallet },
    })).response.status).toBe(409);

    const pending = await json('/api/delegation/transfers', {
      method: 'POST', session: owner,
      body: { fromAccountId: ownerCash, toAccountId: wallet, amount: 500, purpose: 'Wallet funding', occurredOn: DAY },
    });
    let book = await json('/api/book', { session: owner });
    expect(book.data.balances.accounts[ownerCash]).toBe(5000);
    expect(book.data.balances.accounts[wallet]).toBe(0);

    expect((await json(`/api/delegation/transfers/${pending.data.id}/confirm`, {
      method: 'POST', session: delegate, body: {},
    })).response.status).toBe(200);
    expect((await json(`/api/delegation/transfers/${pending.data.id}/confirm`, {
      method: 'POST', session: delegate, body: {},
    })).response.status).toBe(409);
    book = await json('/api/book', { session: owner });
    expect(book.data.balances.accounts[ownerCash]).toBe(4500);
    expect(book.data.balances.accounts[wallet]).toBe(500);

    const rejected = await json('/api/delegation/transfers', {
      method: 'POST', session: owner,
      body: { fromAccountId: ownerCash, toAccountId: wallet, amount: 50, purpose: 'Reject this', occurredOn: DAY },
    });
    expect((await json(`/api/delegation/transfers/${rejected.data.id}/reject`, {
      method: 'POST', session: delegate, body: {},
    })).response.status).toBe(200);

    const payload = {
      occurredOn: DAY, kind: 'expense', amount: 100, purpose: 'Site materials', raw: 'site materials',
      accountId: wallet, clientRef: 'phase3-spend-001',
    };
    const [first, duplicate] = await Promise.all([
      json('/api/entries', { method: 'POST', session: delegate, body: payload }),
      json('/api/entries', { method: 'POST', session: delegate, body: payload }),
    ]);
    expect(first.response.status).toBe(201);
    expect(duplicate.response.status).toBe(201);
    expect(first.data.id).toBe(duplicate.data.id);
    spendEntry = first.data.id;
    expect(Number((await rows<{ n: string }>(`SELECT count(*) AS n FROM entries WHERE client_ref='phase3-spend-001'`))[0].n)).toBe(1);

    expect((await json('/api/book', { session: delegate })).data.balances.accounts[wallet]).toBe(400);
    expect((await json('/api/entries', {
      method: 'POST', session: delegate, body: { ...payload, amount: 401, clientRef: 'phase3-overdraft' },
    })).response.status).toBe(409);
    expect((await json('/api/entries', {
      method: 'POST', session: delegate, body: { ...payload, accountId: ownerCash, amount: 1, clientRef: 'phase3-hidden-account' },
    })).response.status).toBe(403);
  });

  it('covers approvals, private evidence, language persistence and password-session invalidation', async () => {
    const requested = await json('/api/delegation/approvals', {
      method: 'POST', session: delegate, body: { text: 'Need cement', amount: 120, accountId: wallet },
    });
    approval = requested.data.id;
    expect((await json(`/api/delegation/approvals/${approval}/decision`, {
      method: 'POST', session: owner, body: { status: 'approved', note: 'Approved for site' },
    })).response.status).toBe(200);
    expect((await json(`/api/delegation/approvals/${approval}/decision`, {
      method: 'POST', session: owner, body: { status: 'rejected', note: 'second decision' },
    })).response.status).toBe(404);

    const secondRequest = await json('/api/delegation/approvals', {
      method: 'POST', session: delegate, body: { text: 'Need tools', amount: 80, accountId: wallet },
    });
    expect((await json(`/api/delegation/approvals/${secondRequest.data.id}/decision`, {
      method: 'POST', session: owner, body: { status: 'rejected', note: 'Use existing tools' },
    })).response.status).toBe(200);

    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const upload = await fetch(`${BASE}/api/delegation/attachments?entryId=${spendEntry}`, {
      method: 'POST',
      headers: {
        cookie: delegate.cookie, 'x-book': '1', 'content-type': 'image/png',
        'x-file-name': encodeURIComponent('site receipt.png'),
      },
      body: bytes as any,
    });
    expect(upload.status).toBe(201);
    attachment = ((await upload.json()) as any).id;
    const download = await fetch(`${BASE}/api/delegation/attachments/${attachment}`, { headers: { cookie: delegate.cookie } });
    expect(download.status).toBe(200);
    expect(download.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
    expect((await fetch(`${BASE}/api/delegation/attachments/${attachment}`, {
      headers: { cookie: otherDelegate.cookie },
    })).status).toBe(403);

    expect((await json('/api/preferences/language', {
      method: 'PATCH', session: delegate, body: { language: 'ar' },
    })).response.status).toBe(200);
    const relogin = await json('/api/login', {
      method: 'POST', body: { email: 'delegate@example.com', password: 'DelegatePass!2026' },
    });
    delegate.cookie = cookieFrom(relogin.response);
    expect((await json('/api/me', { session: delegate })).data.user.language).toBe('ar');

    const oldCookie = delegate.cookie;
    expect((await json(`/api/users/${delegateId}/password`, {
      method: 'POST', session: owner, body: { password: 'DelegateNew!2026' },
    })).response.status).toBe(200);
    expect((await json('/api/book', { session: { cookie: oldCookie } })).response.status).toBe(401);
    expect((await json('/api/login', {
      method: 'POST', body: { email: 'delegate@example.com', password: 'DelegatePass!2026' },
    })).response.status).toBe(401);
    const newLogin = await json('/api/login', {
      method: 'POST', body: { email: 'delegate@example.com', password: 'DelegateNew!2026' },
    });
    delegate.cookie = cookieFrom(newLogin.response);
  });

  it('persists all core accounting effects and keeps corrections/voids auditable', async () => {
    await json('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'credit_purchase', amount: 120, purpose: 'Steel', raw: '', personId: supplier },
    });
    await json('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'supplier_payment', amount: 50, purpose: 'Pay steel', raw: '', accountId: ownerCash, personId: supplier },
    });
    await json('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'person_loan', amount: 30, purpose: 'Loan', raw: '', accountId: ownerCash, personId: borrower },
    });
    await json('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'salary', amount: 40, purpose: 'Salary advance', raw: '', accountId: ownerCash, personId: employee },
    });
    await json('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'receipt', amount: 200, purpose: 'Client receipt', raw: '', accountId: ownerCash, projectId: project },
    });
    await json('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: '2026-08-01', kind: 'receipt', amount: 300, purpose: 'Historical receipt', raw: '', accountId: ownerCash, projectId: project, historical: true },
    });
    await json('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'transfer', amount: 100, purpose: 'Intercompany', raw: '', accountId: ownerCash, toAccountId: businessBCash },
    });

    let book = await json('/api/book', { session: owner });
    expect(book.data.balances.people[supplier]).toBe(-70);
    expect(book.data.balances.people[borrower]).toBe(30);
    expect(book.data.balances.people[employee]).toBe(-60);
    expect(book.data.balances.projects[project]).toBe(500);
    expect(book.data.balances.accounts[ownerCash]).toBe(4480);
    expect(book.data.balances.accounts[businessBCash]).toBe(1100);
    expect(book.data.balances.loans[book.data.loans[0].id]).toBe(-100);

    const wrong = await json('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'expense', amount: 200, purpose: 'Temporary', raw: '', accountId: ownerCash, clientRef: 'phase3-correction' },
    });
    expect((await json(`/api/entries/${wrong.data.id}`, {
      method: 'PATCH', session: owner, body: { amount: 150 },
    })).response.status).toBe(200);
    book = await json('/api/book', { session: owner });
    expect(book.data.balances.accounts[ownerCash]).toBe(4330);
    expect(book.data.entries.find((x: any) => x.id === wrong.data.id).correctedFrom).toBe(200);

    expect((await json(`/api/entries/${wrong.data.id}/void`, {
      method: 'POST', session: owner, body: { reason: 'Not a real expense' },
    })).response.status).toBe(200);
    book = await json('/api/book', { session: owner });
    expect(book.data.balances.accounts[ownerCash]).toBe(4480);
    const kept = book.data.entries.find((x: any) => x.id === wrong.data.id);
    expect(kept.voided).toBe(true);
    expect(kept.voidReason).toBe('Not a real expense');
  });

  it('records critical audit events and protects the sole owner', async () => {
    const actions = (await rows<{ action: string }>('SELECT action FROM audit ORDER BY id')).map((x) => x.action);
    for (const action of [
      'book opened', 'delegated accounts assigned', 'delegated transfer confirmed', 'delegated transfer rejected',
      'delegated expense logged', 'approval approved', 'approval rejected', 'evidence attached', 'password reset',
      'entry corrected', 'entry voided',
    ]) expect(actions).toContain(action);

    expect((await json(`/api/users/${ownerId}`, { method: 'DELETE', session: owner, body: {} })).response.status).toBe(400);
  });
});

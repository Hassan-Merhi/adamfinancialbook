import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe.sequential : describe.skip;
const PORT = 43127;
const BASE = `http://127.0.0.1:${PORT}`;
const TODAY = '2026-09-05';

let server: ChildProcessWithoutNullStreams | null = null;
let logs = '';

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie');
  if (!value) throw new Error('Expected a session cookie.');
  return value.split(';', 1)[0];
}

async function jsonRequest(
  path: string,
  options: {
    method?: string;
    cookie?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const method = options.method ?? 'GET';
  const headers = new Headers(options.headers);
  if (options.cookie) headers.set('cookie', options.cookie);
  if (method !== 'GET' && method !== 'HEAD' && path !== '/api/login' && path !== '/api/first-owner') {
    headers.set('x-book', '1');
  }
  let body: BodyInit | undefined;
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

async function rawRequest(
  path: string,
  options: { method: string; cookie: string; contentType: string; filename?: string; body: Uint8Array },
) {
  const headers = new Headers({
    cookie: options.cookie,
    'x-book': '1',
    'content-type': options.contentType,
  });
  if (options.filename) headers.set('x-file-name', encodeURIComponent(options.filename));
  return fetch(`${BASE}${path}`, {
    method: options.method,
    headers,
    body: options.body as unknown as BodyInit,
  });
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 150; i += 1) {
    if (server?.exitCode !== null) throw new Error(`Test server exited early.\n${logs}`);
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Test server never became healthy.\n${logs}`);
}

async function resetAsLegacyDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL, ssl: false });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    // Reproduce the production shape that caused the users.language failure.
    // Migration 001 must adopt this table and add every newer user column.
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

async function databaseRows<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL, ssl: false });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

suite('production PostgreSQL + HTTP workflows', () => {
  let ownerCookie = '';
  let delegateCookie = '';
  let secondDelegateCookie = '';
  let ownerId = '';
  let delegateId = '';
  let secondDelegateId = '';
  let businessA = '';
  let businessB = '';
  let ownerCash = '';
  let delegatedWallet = '';
  let otherCash = '';
  let supplierId = '';
  let borrowerId = '';
  let employeeId = '';
  let projectId = '';
  let approvalId = '';
  let spendEntryId = '';
  let evidenceId = '';

  beforeAll(async () => {
    await resetAsLegacyDatabase();
    server = spawn(process.execPath, ['--import', 'tsx', 'server/start.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: TEST_DATABASE_URL!,
        SESSION_SECRET: 'phase-3-integration-secret-that-is-long-enough',
        PGSSL: 'off',
        PORT: String(PORT),
        PGPOOL_MAX: '4',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (chunk) => { logs += chunk.toString(); });
    server.stderr.on('data', (chunk) => { logs += chunk.toString(); });
    await waitForServer();
  }, 30_000);

  afterAll(async () => {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([
        once(server, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (TEST_DATABASE_URL) {
      const client = new pg.Client({ connectionString: TEST_DATABASE_URL, ssl: false });
      await client.connect();
      try { await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); } finally { await client.end(); }
    }
  }, 15_000);

  it('upgrades a legacy users table before accepting traffic', async () => {
    const migrationRows = await databaseRows<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    expect(migrationRows.map((r) => Number(r.version))).toEqual([1]);
    const columns = await databaseRows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users'`,
    );
    const names = columns.map((r) => r.column_name);
    expect(names).toContain('language');
    expect(names).toContain('token_version');

    const health = await jsonRequest('/api/health');
    expect(health.response.status).toBe(200);
    expect(health.data).toEqual({ ok: true });
  });

  it('creates the first owner and protects owner-only endpoints', async () => {
    const meBefore = await jsonRequest('/api/me');
    expect(meBefore.data.needsFirstOwner).toBe(true);

    const opened = await jsonRequest('/api/first-owner', {
      method: 'POST',
      body: { email: 'owner@example.com', password: 'OwnerPass!2026' },
    });
    expect(opened.response.status).toBe(201);
    ownerCookie = cookieFrom(opened.response);
    ownerId = opened.data.user.id;

    const secondFirstOwner = await jsonRequest('/api/first-owner', {
      method: 'POST',
      body: { email: 'attacker@example.com', password: 'AttackPass!2026' },
    });
    expect(secondFirstOwner.response.status).toBe(403);

    const noCookie = await jsonRequest('/api/book');
    expect(noCookie.response.status).toBe(401);
  });

  it('sets up businesses, accounts, projects and people through the real API', async () => {
    const a = await jsonRequest('/api/businesses', { method: 'POST', cookie: ownerCookie, body: { name: 'Alpha Construction' } });
    const b = await jsonRequest('/api/businesses', { method: 'POST', cookie: ownerCookie, body: { name: 'Beta Trading' } });
    expect(a.response.status).toBe(201);
    expect(b.response.status).toBe(201);
    businessA = a.data.id;
    businessB = b.data.id;

    const cash = await jsonRequest('/api/accounts', {
      method: 'POST', cookie: ownerCookie,
      body: { name: 'Owner Cash', businessId: businessA, opening: 5000 },
    });
    const wallet = await jsonRequest('/api/accounts', {
      method: 'POST', cookie: ownerCookie,
      body: { name: 'Delegate Wallet', businessId: businessA, opening: 0 },
    });
    const other = await jsonRequest('/api/accounts', {
      method: 'POST', cookie: ownerCookie,
      body: { name: 'Beta Cash', businessId: businessB, opening: 1000 },
    });
    ownerCash = cash.data.id;
    delegatedWallet = wallet.data.id;
    otherCash = other.data.id;

    const project = await jsonRequest('/api/projects', {
      method: 'POST', cookie: ownerCookie,
      body: { name: 'Warehouse', scope: 'Construction', businessId: businessA, opening: 0 },
    });
    projectId = project.data.id;

    const supplier = await jsonRequest('/api/people', {
      method: 'POST', cookie: ownerCookie,
      body: { name: 'Steel Supplier', businessId: businessA, opening: 0, kind: 'payable', role: 'Supplier', salary: 0 },
    });
    const borrower = await jsonRequest('/api/people', {
      method: 'POST', cookie: ownerCookie,
      body: { name: 'Borrower', businessId: businessA, opening: 0, kind: 'receivable', role: 'Loan', salary: 0 },
    });
    const employee = await jsonRequest('/api/people', {
      method: 'POST', cookie: ownerCookie,
      body: { name: 'Worker', businessId: businessA, opening: 0, kind: 'salary', role: 'Staff', salary: 100 },
    });
    supplierId = supplier.data.id;
    borrowerId = borrower.data.id;
    employeeId = employee.data.id;
  });

  it('creates delegated users and enforces one-user-per-account assignment atomically', async () => {
    const delegate = await jsonRequest('/api/users', {
      method: 'POST', cookie: ownerCookie,
      body: { email: 'delegate@example.com', password: 'DelegatePass!2026', role: 'entry' },
    });
    const second = await jsonRequest('/api/users', {
      method: 'POST', cookie: ownerCookie,
      body: { email: 'delegate2@example.com', password: 'Delegate2Pass!2026', role: 'entry' },
    });
    delegateId = delegate.data.user.id;
    secondDelegateId = second.data.user.id;

    const assigned = await jsonRequest(`/api/delegation/users/${delegateId}/accounts`, {
      method: 'PUT', cookie: ownerCookie, body: { accountIds: [delegatedWallet] },
    });
    expect(assigned.response.status).toBe(200);

    const conflict = await jsonRequest(`/api/delegation/users/${secondDelegateId}/accounts`, {
      method: 'PUT', cookie: ownerCookie, body: { accountIds: [delegatedWallet] },
    });
    expect(conflict.response.status).toBe(409);

    const login = await jsonRequest('/api/login', {
      method: 'POST', body: { email: 'delegate@example.com', password: 'DelegatePass!2026' },
    });
    delegateCookie = cookieFrom(login.response);
    const login2 = await jsonRequest('/api/login', {
      method: 'POST', body: { email: 'delegate2@example.com', password: 'Delegate2Pass!2026' },
    });
    secondDelegateCookie = cookieFrom(login2.response);

    const delegateBook = await jsonRequest('/api/book', { cookie: delegateCookie });
    expect(delegateBook.data.accounts.map((x: any) => x.id)).toEqual([delegatedWallet]);
    expect(delegateBook.data.businesses.map((x: any) => x.id)).toEqual([businessA]);

    const secondBook = await jsonRequest('/api/book', { cookie: secondDelegateCookie });
    expect(secondBook.data.accounts).toHaveLength(0);
  });

  it('blocks direct owner transfer into a delegated wallet and requires confirmation', async () => {
    const blocked = await jsonRequest('/api/entries', {
      method: 'POST', cookie: ownerCookie,
      body: {
        occurredOn: TODAY, kind: 'transfer', amount: 500, purpose: 'Direct transfer', raw: '',
        accountId: ownerCash, toAccountId: delegatedWallet,
      },
    });
    expect(blocked.response.status).toBe(409);

    const pending = await jsonRequest('/api/delegation/transfers', {
      method: 'POST', cookie: ownerCookie,
      body: { fromAccountId: ownerCash, toAccountId: delegatedWallet, amount: 500, purpose: 'Wallet funding', occurredOn: TODAY },
    });
    expect(pending.response.status).toBe(201);
    const transferId = pending.data.id;

    const before = await jsonRequest('/api/book', { cookie: ownerCookie });
    expect(before.data.balances.accounts[ownerCash]).toBe(5000);
    expect(before.data.balances.accounts[delegatedWallet]).toBe(0);

    const confirmed = await jsonRequest(`/api/delegation/transfers/${transferId}/confirm`, {
      method: 'POST', cookie: delegateCookie, body: {},
    });
    expect(confirmed.response.status).toBe(200);

    const again = await jsonRequest(`/api/delegation/transfers/${transferId}/confirm`, {
      method: 'POST', cookie: delegateCookie, body: {},
    });
    expect(again.response.status).toBe(409);

    const after = await jsonRequest('/api/book', { cookie: ownerCookie });
    expect(after.data.balances.accounts[ownerCash]).toBe(4500);
    expect(after.data.balances.accounts[delegatedWallet]).toBe(500);
  });

  it('rejecting a delegated transfer posts no financial movement', async () => {
    const pending = await jsonRequest('/api/delegation/transfers', {
      method: 'POST', cookie: ownerCookie,
      body: { fromAccountId: ownerCash, toAccountId: delegatedWallet, amount: 50, purpose: 'Rejected handoff', occurredOn: TODAY },
    });
    const rejected = await jsonRequest(`/api/delegation/transfers/${pending.data.id}/reject`, {
      method: 'POST', cookie: delegateCookie, body: {},
    });
    expect(rejected.response.status).toBe(200);
    const book = await jsonRequest('/api/book', { cookie: ownerCookie });
    expect(book.data.balances.accounts[ownerCash]).toBe(4500);
    expect(book.data.balances.accounts[delegatedWallet]).toBe(500);
  });

  it('limits delegated spending to assigned funds and makes duplicate submissions idempotent', async () => {
    const payload = {
      occurredOn: TODAY,
      kind: 'expense',
      amount: 100,
      purpose: 'Site materials',
      raw: 'bought site materials',
      accountId: delegatedWallet,
      clientRef: 'phase3-delegated-spend-001',
    };
    const [one, two] = await Promise.all([
      jsonRequest('/api/entries', { method: 'POST', cookie: delegateCookie, body: payload }),
      jsonRequest('/api/entries', { method: 'POST', cookie: delegateCookie, body: payload }),
    ]);
    expect(one.response.status).toBe(201);
    expect(two.response.status).toBe(201);
    expect(one.data.id).toBe(two.data.id);
    spendEntryId = one.data.id;

    const rows = await databaseRows<{ n: number }>(
      `SELECT count(*)::int AS n FROM entries WHERE client_ref = 'phase3-delegated-spend-001'`,
    );
    expect(rows[0].n).toBe(1);

    const book = await jsonRequest('/api/book', { cookie: delegateCookie });
    expect(book.data.balances.accounts[delegatedWallet]).toBe(400);

    const overspend = await jsonRequest('/api/entries', {
      method: 'POST', cookie: delegateCookie,
      body: { ...payload, amount: 401, clientRef: 'phase3-overdraft' },
    });
    expect(overspend.response.status).toBe(409);

    const wrongAccount = await jsonRequest('/api/entries', {
      method: 'POST', cookie: delegateCookie,
      body: { ...payload, accountId: ownerCash, amount: 1, clientRef: 'phase3-wrong-account' },
    });
    expect(wrongAccount.response.status).toBe(403);

    const ownerSetup = await jsonRequest('/api/businesses', {
      method: 'POST', cookie: delegateCookie, body: { name: 'Forbidden' },
    });
    expect(ownerSetup.response.status).toBe(403);

    const hiddenStatement = await jsonRequest(`/api/statement?type=account&id=${ownerCash}`, { cookie: delegateCookie });
    expect(hiddenStatement.response.status).toBe(403);
    const ownStatement = await jsonRequest(`/api/statement?type=account&id=${delegatedWallet}`, { cookie: delegateCookie });
    expect(ownStatement.response.status).toBe(200);
  });

  it('runs approval approve/reject workflows and preserves requester privacy', async () => {
    const request = await jsonRequest('/api/delegation/approvals', {
      method: 'POST', cookie: delegateCookie,
      body: { text: 'Need cement', amount: 120, accountId: delegatedWallet },
    });
    expect(request.response.status).toBe(201);
    approvalId = request.data.id;

    const ownerDashboard = await jsonRequest('/api/delegation/dashboard', { cookie: ownerCookie });
    expect(ownerDashboard.data.approvals.some((x: any) => x.id === approvalId && x.status === 'pending')).toBe(true);

    const decision = await jsonRequest(`/api/delegation/approvals/${approvalId}/decision`, {
      method: 'POST', cookie: ownerCookie,
      body: { status: 'approved', note: 'Approved for site' },
    });
    expect(decision.response.status).toBe(200);

    const secondDecision = await jsonRequest(`/api/delegation/approvals/${approvalId}/decision`, {
      method: 'POST', cookie: ownerCookie,
      body: { status: 'rejected', note: 'too late' },
    });
    expect(secondDecision.response.status).toBe(404);

    const rejectedRequest = await jsonRequest('/api/delegation/approvals', {
      method: 'POST', cookie: delegateCookie,
      body: { text: 'Need extra tools', amount: 80, accountId: delegatedWallet },
    });
    const rejection = await jsonRequest(`/api/delegation/approvals/${rejectedRequest.data.id}/decision`, {
      method: 'POST', cookie: ownerCookie,
      body: { status: 'rejected', note: 'Use existing tools' },
    });
    expect(rejection.response.status).toBe(200);

    const otherUserList = await jsonRequest(`/api/delegation/attachments?requestId=${approvalId}`, { cookie: secondDelegateCookie });
    expect(otherUserList.response.status).toBe(403);
  });

  it('stores receipt evidence privately and returns the original bytes', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const uploaded = await rawRequest(`/api/delegation/attachments?entryId=${spendEntryId}`, {
      method: 'POST', cookie: delegateCookie, contentType: 'image/png', filename: 'site receipt.png', body: bytes,
    });
    expect(uploaded.status).toBe(201);
    const uploadedBody = await uploaded.json() as any;
    evidenceId = uploadedBody.id;
    expect(uploadedBody.filename).toBe('site receipt.png');
    expect(uploadedBody.byteSize).toBe(bytes.length);

    const list = await jsonRequest(`/api/delegation/attachments?entryId=${spendEntryId}`, { cookie: delegateCookie });
    expect(list.response.status).toBe(200);
    expect(list.data.files.some((x: any) => x.id === evidenceId)).toBe(true);

    const download = await fetch(`${BASE}/api/delegation/attachments/${evidenceId}`, {
      headers: { cookie: delegateCookie },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('cache-control')).toContain('no-store');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);

    const forbidden = await fetch(`${BASE}/api/delegation/attachments/${evidenceId}`, {
      headers: { cookie: secondDelegateCookie },
    });
    expect(forbidden.status).toBe(403);
  });

  it('persists language preference across sessions', async () => {
    const changed = await jsonRequest('/api/preferences/language', {
      method: 'PATCH', cookie: delegateCookie, body: { language: 'ar' },
    });
    expect(changed.response.status).toBe(200);
    expect(changed.data.language).toBe('ar');

    const login = await jsonRequest('/api/login', {
      method: 'POST', body: { email: 'delegate@example.com', password: 'DelegatePass!2026' },
    });
    const reloggedCookie = cookieFrom(login.response);
    const me = await jsonRequest('/api/me', { cookie: reloggedCookie });
    expect(me.data.user.language).toBe('ar');
    delegateCookie = reloggedCookie;
  });

  it('invalidates old sessions when the owner resets a delegated password', async () => {
    const oldCookie = delegateCookie;
    const reset = await jsonRequest(`/api/users/${delegateId}/password`, {
      method: 'POST', cookie: ownerCookie, body: { password: 'DelegateNew!2026' },
    });
    expect(reset.response.status).toBe(200);

    const oldSession = await jsonRequest('/api/book', { cookie: oldCookie });
    expect(oldSession.response.status).toBe(401);

    const oldPassword = await jsonRequest('/api/login', {
      method: 'POST', body: { email: 'delegate@example.com', password: 'DelegatePass!2026' },
    });
    expect(oldPassword.response.status).toBe(401);

    const newLogin = await jsonRequest('/api/login', {
      method: 'POST', body: { email: 'delegate@example.com', password: 'DelegateNew!2026' },
    });
    expect(newLogin.response.status).toBe(200);
    delegateCookie = cookieFrom(newLogin.response);
  });

  it('posts supplier, receivable, salary, project receipt and intercompany effects correctly', async () => {
    const credit = await jsonRequest('/api/entries', {
      method: 'POST', cookie: ownerCookie,
      body: { occurredOn: TODAY, kind: 'credit_purchase', amount: 120, purpose: 'Steel', raw: '', personId: supplierId },
    });
    expect(credit.response.status).toBe(201);
    await jsonRequest('/api/entries', {
      method: 'POST', cookie: ownerCookie,
      body: { occurredOn: TODAY, kind: 'supplier_payment', amount: 50, purpose: 'Pay steel', raw: '', accountId: ownerCash, personId: supplierId },
    });
    await jsonRequest('/api/entries', {
      method: 'POST', cookie: ownerCookie,
      body: { occurredOn: TODAY, kind: 'person_loan', amount: 30, purpose: 'Loan', raw: '', accountId: ownerCash, personId: borrowerId },
    });
    await jsonRequest('/api/entries', {
      method: 'POST', cookie: ownerCookie,
      body: { occurredOn: TODAY, kind: 'salary', amount: 40, purpose: 'Salary advance', raw: '', accountId: ownerCash, personId: employeeId },
    });
    await jsonRequest('/api/entries', {
      method: 'POST', cookie: ownerCookie,
      body: { occurredOn: TODAY, kind: 'receipt', amount: 200, purpose: 'Client receipt', raw: '', accountId: ownerCash, projectId },
    });
    await jsonRequest('/api/entries', {
      method: 'POST', cookie: ownerCookie,
      body: { occurredOn: '2026-08-01', kind: 'receipt', amount: 300, purpose: 'Historical receipt', raw: '', accountId: ownerCash, projectId, historical: true },
    });
    const transfer = await jsonRequest('/api/entries', {
      method: 'POST', cookie: ownerCookie,
      body: { occurredOn: TODAY, kind: 'transfer', amount: 100, purpose: 'Intercompany', raw: '', accountId: ownerCash, toAccountId: otherCash },
    });
    expect(transfer.response.status).toBe(201);

    const book = await jsonRequest('/api/book', { cookie: ownerCookie });
    expect(book.data.balances.people[supplierId]).toBe(-70);
    expect(book.data.balances.people[borrowerId]).toBe(30);
    expect(book.data.balances.people[employeeId]).toBe(-60);
    expect(book.data.balances.projects[projectId]).toBe(500);
    // 4500 after confirmed wallet funding, then -50 -30 -40 +200 -100.
    // Historical receipt adds project history but never today's cash.
    expect(book.data.balances.accounts[ownerCash]).toBe(4480);
    expect(book.data.balances.accounts[otherCash]).toBe(1100);
    expect(book.data.loans).toHaveLength(1);
    expect(book.data.balances.loans[book.data.loans[0].id]).toBe(-100);
  });

  it('correction and void preserve history while restoring the financial balance', async () => {
    const entry = await jsonRequest('/api/entries', {
      method: 'POST', cookie: ownerCookie,
      body: {
        occurredOn: TODAY, kind: 'expense', amount: 200, purpose: 'Temporary amount', raw: '',
        accountId: ownerCash, clientRef: 'phase3-owner-correction',
      },
    });
    expect(entry.response.status).toBe(201);

    let book = await jsonRequest('/api/book', { cookie: ownerCookie });
    expect(book.data.balances.accounts[ownerCash]).toBe(4280);

    const corrected = await jsonRequest(`/api/entries/${entry.data.id}`, {
      method: 'PATCH', cookie: ownerCookie, body: { amount: 150 },
    });
    expect(corrected.response.status).toBe(200);
    book = await jsonRequest('/api/book', { cookie: ownerCookie });
    expect(book.data.balances.accounts[ownerCash]).toBe(4330);
    const correctedEntry = book.data.entries.find((x: any) => x.id === entry.data.id);
    expect(correctedEntry.correctedFrom).toBe(200);
    expect(correctedEntry.amount).toBe(150);

    const voided = await jsonRequest(`/api/entries/${entry.data.id}/void`, {
      method: 'POST', cookie: ownerCookie, body: { reason: 'Test correction was not a real expense' },
    });
    expect(voided.response.status).toBe(200);
    book = await jsonRequest('/api/book', { cookie: ownerCookie });
    expect(book.data.balances.accounts[ownerCash]).toBe(4480);
    const kept = book.data.entries.find((x: any) => x.id === entry.data.id);
    expect(kept.voided).toBe(true);
    expect(kept.voidReason).toContain('not a real expense');
  });

  it('keeps audit evidence for critical workflow events', async () => {
    const rows = await databaseRows<{ action: string }>('SELECT action FROM audit ORDER BY id');
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('book opened');
    expect(actions).toContain('delegated accounts assigned');
    expect(actions).toContain('delegated transfer confirmed');
    expect(actions).toContain('delegated transfer rejected');
    expect(actions).toContain('delegated expense logged');
    expect(actions).toContain('approval approved');
    expect(actions).toContain('approval rejected');
    expect(actions).toContain('evidence attached');
    expect(actions).toContain('password reset');
    expect(actions).toContain('entry corrected');
    expect(actions).toContain('entry voided');
  });

  it('does not let the sole owner remove themselves', async () => {
    const response = await jsonRequest(`/api/users/${ownerId}`, { method: 'DELETE', cookie: ownerCookie, body: {} });
    expect(response.response.status).toBe(400);
  });
});

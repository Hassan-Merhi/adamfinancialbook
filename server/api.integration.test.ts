import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = 43128;
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = '2026-09-05';
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
  options: { method?: string; session?: Session; body?: unknown; bookHeader?: boolean } = {},
) {
  const method = options.method ?? 'GET';
  const headers = new Headers();
  if (options.session) headers.set('cookie', options.session.cookie);
  const needsBookHeader = method !== 'GET' && method !== 'HEAD'
    && path !== '/api/login' && path !== '/api/first-owner';
  if (needsBookHeader && options.bookHeader !== false) headers.set('x-book', '1');
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

describe.skipIf(!DATABASE_URL)('real PostgreSQL API', () => {
  const owner: Session = { cookie: '' };
  const delegate: Session = { cookie: '' };
  const outsider: Session = { cookie: '' };
  let ownerId = '';
  let delegateId = '';
  let outsiderId = '';
  let alpha = '';
  let beta = '';
  let ownerCash = '';
  let wallet = '';
  let betaCash = '';
  let project = '';
  let supplier = '';
  let borrower = '';
  let worker = '';
  let delegatedEntry = '';

  beforeAll(async () => {
    await resetToLegacyShape();
    child = spawn(process.execPath, ['--import', 'tsx', 'server/start.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: DATABASE_URL!,
        SESSION_SECRET: 'phase-3-integration-secret-that-is-long-enough',
        PGSSL: 'off',
        PGPOOL_MAX: '4',
        PORT: String(PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => { serverLog += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { serverLog += chunk.toString(); });
    await waitUntilHealthy();
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

  it('migrates legacy schema, protects mutations, and bootstraps one owner', async () => {
    expect((await db<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')).map((x) => Number(x.version))).toEqual([1, 2, 3, 4]);
    const columns = (await db<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users'`,
    )).map((x) => x.column_name);
    expect(columns).toEqual(expect.arrayContaining(['language', 'token_version']));
    const entryColumns = (await db<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='entries'`,
    )).map((x) => x.column_name);
    expect(entryColumns).toEqual(expect.arrayContaining([
      'review_category', 'reviewed_by', 'reviewed_at', 'transaction_id',
      'corrected_at', 'corrected_by', 'correction_reason', 'voided_at', 'voided_by',
    ]));
    const effectColumns = (await db<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='effects'`,
    )).map((x) => x.column_name);
    expect(effectColumns).toEqual(expect.arrayContaining(['active', 'superseded_at', 'superseded_by']));
    expect((await db<{ name: string | null }>(`SELECT to_regclass('public.entry_revisions')::text AS name`))[0].name).toBe('entry_revisions');
    expect((await request('/api/book')).response.status).toBe(401);
    expect((await request('/api/me')).data.needsFirstOwner).toBe(true);

    const opened = await request('/api/first-owner', {
      method: 'POST', body: { email: 'owner@example.com', password: 'OwnerPass!2026' },
    });
    expect(opened.response.status).toBe(201);
    owner.cookie = sessionCookie(opened.response);
    ownerId = opened.data.user.id;
    expect((await request('/api/first-owner', {
      method: 'POST', body: { email: 'second@example.com', password: 'SecondPass!2026' },
    })).response.status).toBe(403);

    const noCsrfHeader = await request('/api/businesses', {
      method: 'POST', session: owner, bookHeader: false, body: { name: 'Blocked' },
    });
    expect(noCsrfHeader.response.status).toBe(403);
  });

  it('enforces delegated wallets, confirmed handoffs, funds limits, idempotency, and owner assignment', async () => {
    alpha = (await request('/api/businesses', { method: 'POST', session: owner, body: { name: 'Alpha Construction' } })).data.id;
    beta = (await request('/api/businesses', { method: 'POST', session: owner, body: { name: 'Beta Trading' } })).data.id;
    ownerCash = (await request('/api/accounts', {
      method: 'POST', session: owner, body: { name: 'Owner Cash', businessId: alpha, opening: 5000 },
    })).data.id;
    wallet = (await request('/api/accounts', {
      method: 'POST', session: owner, body: { name: 'Delegate Wallet', businessId: alpha, opening: 0 },
    })).data.id;
    betaCash = (await request('/api/accounts', {
      method: 'POST', session: owner, body: { name: 'Beta Cash', businessId: beta, opening: 1000 },
    })).data.id;
    project = (await request('/api/projects', {
      method: 'POST', session: owner, body: { name: 'Warehouse', scope: 'Construction', businessId: alpha, opening: 0 },
    })).data.id;
    supplier = (await request('/api/people', {
      method: 'POST', session: owner,
      body: { name: 'Supplier', businessId: alpha, opening: 0, kind: 'payable', role: 'Supplier', salary: 0 },
    })).data.id;
    borrower = (await request('/api/people', {
      method: 'POST', session: owner,
      body: { name: 'Borrower', businessId: alpha, opening: 0, kind: 'receivable', role: 'Loan', salary: 0 },
    })).data.id;
    worker = (await request('/api/people', {
      method: 'POST', session: owner,
      body: { name: 'Worker', businessId: alpha, opening: 0, kind: 'salary', role: 'Staff', salary: 100 },
    })).data.id;

    const user = await request('/api/users', {
      method: 'POST', session: owner,
      body: { email: 'delegate@example.com', password: 'DelegatePass!2026', role: 'entry' },
    });
    const other = await request('/api/users', {
      method: 'POST', session: owner,
      body: { email: 'outsider@example.com', password: 'OutsiderPass!2026', role: 'entry' },
    });
    delegateId = user.data.user.id;
    outsiderId = other.data.user.id;
    expect((await request(`/api/delegation/users/${delegateId}/accounts`, {
      method: 'PUT', session: owner, body: { accountIds: [wallet] },
    })).response.status).toBe(200);
    expect((await request(`/api/delegation/users/${outsiderId}/accounts`, {
      method: 'PUT', session: owner, body: { accountIds: [wallet] },
    })).response.status).toBe(409);

    const loggedIn = await request('/api/login', {
      method: 'POST', body: { email: 'delegate@example.com', password: 'DelegatePass!2026' },
    });
    const outsiderLogin = await request('/api/login', {
      method: 'POST', body: { email: 'outsider@example.com', password: 'OutsiderPass!2026' },
    });
    delegate.cookie = sessionCookie(loggedIn.response);
    outsider.cookie = sessionCookie(outsiderLogin.response);

    const view = await request('/api/book', { session: delegate });
    expect(view.data.accounts.map((x: any) => x.id)).toEqual([wallet]);
    expect(view.data.businesses.map((x: any) => x.id)).toEqual([alpha]);
    expect((await request('/api/businesses', { method: 'POST', session: delegate, body: { name: 'Forbidden' } })).response.status).toBe(403);
    expect((await request(`/api/statement?type=account&id=${ownerCash}`, { session: delegate })).response.status).toBe(403);

    expect((await request('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'transfer', amount: 500, purpose: 'Direct', raw: '', accountId: ownerCash, toAccountId: wallet },
    })).response.status).toBe(409);

    const handoff = await request('/api/delegation/transfers', {
      method: 'POST', session: owner,
      body: { fromAccountId: ownerCash, toAccountId: wallet, amount: 500, purpose: 'Wallet funding', occurredOn: DAY },
    });
    let full = await request('/api/book', { session: owner });
    expect(full.data.balances.accounts[ownerCash]).toBe(5000);
    expect(full.data.balances.accounts[wallet]).toBe(0);
    expect((await request(`/api/delegation/transfers/${handoff.data.id}/confirm`, {
      method: 'POST', session: delegate, body: {},
    })).response.status).toBe(200);
    expect((await request(`/api/delegation/transfers/${handoff.data.id}/confirm`, {
      method: 'POST', session: delegate, body: {},
    })).response.status).toBe(409);
    const confirmed = (await db<{ status: string; entry_id: string | null }>(
      'SELECT status, entry_id FROM pending_transfers WHERE id = $1', [handoff.data.id],
    ))[0];
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.entry_id).toBeTruthy();
    full = await request('/api/book', { session: owner });
    expect(full.data.balances.accounts[ownerCash]).toBe(4500);
    expect(full.data.balances.accounts[wallet]).toBe(500);

    const rejectMe = await request('/api/delegation/transfers', {
      method: 'POST', session: owner,
      body: { fromAccountId: ownerCash, toAccountId: wallet, amount: 50, purpose: 'Reject', occurredOn: DAY },
    });
    expect((await request(`/api/delegation/transfers/${rejectMe.data.id}/reject`, {
      method: 'POST', session: delegate, body: {},
    })).response.status).toBe(200);

    const spend = {
      occurredOn: DAY, kind: 'expense', amount: 100, purpose: 'Materials', raw: 'materials',
      accountId: wallet, clientRef: 'phase3-spend-once',
    };
    const [a, b] = await Promise.all([
      request('/api/entries', { method: 'POST', session: delegate, body: spend }),
      request('/api/entries', { method: 'POST', session: delegate, body: spend }),
    ]);
    expect(a.response.status).toBe(201);
    expect(b.response.status).toBe(201);
    expect(a.data.id).toBe(b.data.id);
    delegatedEntry = a.data.id;
    expect(Number((await db<{ n: string }>(`SELECT count(*) AS n FROM entries WHERE client_ref='phase3-spend-once'`))[0].n)).toBe(1);
    const postedMeta = (await db<{ transaction_id: string }>(
      'SELECT transaction_id FROM entries WHERE id = $1', [delegatedEntry],
    ))[0];
    expect(postedMeta.transaction_id).toMatch(/^txn_/);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM audit WHERE subject = $1 AND action = 'financial entry posted' AND transaction_id = $2`,
      [delegatedEntry, postedMeta.transaction_id],
    ))[0].n)).toBe(1);
    expect((await request('/api/book', { session: delegate })).data.balances.accounts[wallet]).toBe(400);
    expect((await request('/api/entries', {
      method: 'POST', session: delegate, body: { ...spend, amount: 401, clientRef: 'phase3-overdraft' },
    })).response.status).toBe(409);
    expect((await request('/api/entries', {
      method: 'POST', session: delegate, body: { ...spend, accountId: ownerCash, amount: 1, clientRef: 'phase3-hidden' },
    })).response.status).toBe(403);

    const queue = await request('/api/delegation/expense-reviews', { session: owner });
    expect(queue.response.status).toBe(200);
    expect(queue.data.items.map((item: any) => item.id)).toContain(delegatedEntry);
    expect((await request('/api/delegation/expense-reviews', { session: delegate })).data.items).toEqual([]);

    const beforeAssign = await request('/api/book', { session: owner });
    const assigned = await request('/api/delegation/expense-reviews/assign', {
      method: 'POST', session: owner,
      body: { entryIds: [delegatedEntry], businessId: alpha, projectId: project, category: 'Materials' },
    });
    expect(assigned.response.status).toBe(200);
    expect(assigned.data.count).toBe(1);

    const afterAssign = await request('/api/book', { session: owner });
    expect(afterAssign.data.balances.accounts[wallet]).toBe(beforeAssign.data.balances.accounts[wallet]);
    const reviewed = afterAssign.data.entries.find((entry: any) => entry.id === delegatedEntry);
    expect(reviewed.projectId).toBe(project);
    expect(reviewed.forBusiness).toBe(alpha);
    expect(reviewed.effects.filter((effect: any) => effect.type === 'account')).toHaveLength(1);
    expect(reviewed.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'account', targetId: wallet, delta: -100 }),
      expect.objectContaining({ type: 'cost', targetId: project, delta: 100 }),
    ]));
    const reviewRow = (await db<{ review_category: string; reviewed_at: Date | null }>(
      'SELECT review_category, reviewed_at FROM entries WHERE id = $1', [delegatedEntry],
    ))[0];
    expect(reviewRow.review_category).toBe('Materials');
    expect(reviewRow.reviewed_at).not.toBeNull();
    const historicalEffects = await db<{ active: boolean; superseded_at: Date | null }>(
      'SELECT active, superseded_at FROM effects WHERE entry_id = $1 ORDER BY id', [delegatedEntry],
    );
    expect(historicalEffects.some((row) => row.active === false && row.superseded_at !== null)).toBe(true);
    expect(historicalEffects.some((row) => row.active === true)).toBe(true);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM entry_revisions WHERE entry_id = $1 AND revision_type = 'classification'`, [delegatedEntry],
    ))[0].n)).toBe(1);
    expect((await request('/api/delegation/expense-reviews', { session: owner })).data.items).toHaveLength(0);
    expect((await request('/api/delegation/expense-reviews/assign', {
      method: 'POST', session: owner,
      body: { entryIds: [delegatedEntry], businessId: alpha, projectId: project, category: 'Again' },
    })).response.status).toBe(409);
  });

  it('covers approvals, evidence privacy, language persistence, and session revocation', async () => {
    const approval = await request('/api/delegation/approvals', {
      method: 'POST', session: delegate, body: { text: 'Need cement', amount: 120, accountId: wallet },
    });
    expect(approval.response.status).toBe(201);
    expect((await request(`/api/delegation/approvals/${approval.data.id}/decision`, {
      method: 'POST', session: owner, body: { status: 'approved', note: 'Approved' },
    })).response.status).toBe(200);
    expect((await request(`/api/delegation/approvals/${approval.data.id}/decision`, {
      method: 'POST', session: owner, body: { status: 'rejected', note: 'Second decision' },
    })).response.status).toBe(404);

    const rejected = await request('/api/delegation/approvals', {
      method: 'POST', session: delegate, body: { text: 'Need tools', amount: 80, accountId: wallet },
    });
    expect((await request(`/api/delegation/approvals/${rejected.data.id}/decision`, {
      method: 'POST', session: owner, body: { status: 'rejected', note: 'Use existing tools' },
    })).response.status).toBe(200);

    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const upload = await fetch(`${BASE}/api/delegation/attachments?entryId=${delegatedEntry}`, {
      method: 'POST',
      headers: {
        cookie: delegate.cookie,
        'x-book': '1',
        'content-type': 'image/png',
        'x-file-name': encodeURIComponent('site receipt.png'),
      },
      body: bytes as any,
    });
    expect(upload.status).toBe(201);
    const fileId = ((await upload.json()) as any).id;
    const download = await fetch(`${BASE}/api/delegation/attachments/${fileId}`, { headers: { cookie: delegate.cookie } });
    expect(download.status).toBe(200);
    expect(download.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
    expect((await fetch(`${BASE}/api/delegation/attachments/${fileId}`, { headers: { cookie: outsider.cookie } })).status).toBe(403);

    expect((await request('/api/preferences/language', {
      method: 'PATCH', session: delegate, body: { language: 'ar' },
    })).response.status).toBe(200);
    const languageLogin = await request('/api/login', {
      method: 'POST', body: { email: 'delegate@example.com', password: 'DelegatePass!2026' },
    });
    delegate.cookie = sessionCookie(languageLogin.response);
    expect((await request('/api/me', { session: delegate })).data.user.language).toBe('ar');

    const oldSession = delegate.cookie;
    expect((await request(`/api/users/${delegateId}/password`, {
      method: 'POST', session: owner, body: { password: 'DelegateNew!2026' },
    })).response.status).toBe(200);
    expect((await request('/api/book', { session: { cookie: oldSession } })).response.status).toBe(401);
    expect((await request('/api/login', {
      method: 'POST', body: { email: 'delegate@example.com', password: 'DelegatePass!2026' },
    })).response.status).toBe(401);
    const newLogin = await request('/api/login', {
      method: 'POST', body: { email: 'delegate@example.com', password: 'DelegateNew!2026' },
    });
    expect(newLogin.response.status).toBe(200);
    delegate.cookie = sessionCookie(newLogin.response);
  });

  it('reconciles core accounting effects, intercompany direction, corrections, and voids', async () => {
    await request('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'credit_purchase', amount: 120, purpose: 'Steel', raw: '', personId: supplier },
    });
    await request('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'supplier_payment', amount: 50, purpose: 'Supplier payment', raw: '', accountId: ownerCash, personId: supplier },
    });
    await request('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'person_loan', amount: 30, purpose: 'Loan', raw: '', accountId: ownerCash, personId: borrower },
    });
    await request('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'salary', amount: 40, purpose: 'Salary', raw: '', accountId: ownerCash, personId: worker },
    });
    await request('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'receipt', amount: 200, purpose: 'Client receipt', raw: '', accountId: ownerCash, projectId: project },
    });
    await request('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: '2026-08-01', kind: 'receipt', amount: 300, purpose: 'Historical receipt', raw: '', accountId: ownerCash, projectId: project, historical: true },
    });
    await request('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'transfer', amount: 100, purpose: 'Intercompany', raw: '', accountId: ownerCash, toAccountId: betaCash },
    });

    let book = await request('/api/book', { session: owner });
    expect(book.data.balances.people[supplier]).toBe(-70);
    expect(book.data.balances.people[borrower]).toBe(30);
    expect(book.data.balances.people[worker]).toBe(-60);
    expect(book.data.balances.projects[project]).toBe(500);
    expect(book.data.balances.accounts[ownerCash]).toBe(4480);
    expect(book.data.balances.accounts[betaCash]).toBe(1100);

    const loan = book.data.loans[0];
    const rawLoan = book.data.balances.loans[loan.id];
    // The row's stored orientation is arbitrary. Read it from Alpha's side:
    // positive means the other business owes Alpha. Alpha sent Beta $100, so
    // Beta must owe Alpha $100 regardless of row orientation.
    const alphaSide = loan.fromBusiness === alpha ? -rawLoan : rawLoan;
    expect(alphaSide).toBe(100);

    const wrong = await request('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'expense', amount: 200, purpose: 'Temporary', raw: '', accountId: ownerCash, clientRef: 'phase3-correction' },
    });
    expect((await request(`/api/entries/${wrong.data.id}`, {
      method: 'PATCH', session: owner, body: { amount: 150 },
    })).response.status).toBe(200);
    book = await request('/api/book', { session: owner });
    expect(book.data.balances.accounts[ownerCash]).toBe(4330);
    const corrected = book.data.entries.find((x: any) => x.id === wrong.data.id);
    expect(corrected.correctedFrom).toBe(200);
    expect(corrected.correctedAt).toBeTruthy();
    expect(corrected.correctedBy).toBe(ownerId);
    expect(corrected.correctionReason).toContain('200.00');
    const correctedEffects = await db<{ active: boolean; superseded_at: Date | null }>(
      'SELECT active, superseded_at FROM effects WHERE entry_id = $1 ORDER BY id', [wrong.data.id],
    );
    expect(correctedEffects.some((row) => row.active === false && row.superseded_at !== null)).toBe(true);
    expect(correctedEffects.some((row) => row.active === true)).toBe(true);
    const correctionRevision = (await db<{ transaction_id: string }>(
      `SELECT transaction_id FROM entry_revisions WHERE entry_id = $1 AND revision_type = 'correction'`, [wrong.data.id],
    ))[0];
    expect(correctionRevision.transaction_id).toMatch(/^txn_/);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM audit WHERE subject = $1 AND action = 'financial entry corrected' AND transaction_id = $2`,
      [wrong.data.id, correctionRevision.transaction_id],
    ))[0].n)).toBe(1);

    expect((await request(`/api/entries/${wrong.data.id}/void`, {
      method: 'POST', session: owner, body: { reason: 'Not a real expense' },
    })).response.status).toBe(200);
    book = await request('/api/book', { session: owner });
    expect(book.data.balances.accounts[ownerCash]).toBe(4480);
    const kept = book.data.entries.find((x: any) => x.id === wrong.data.id);
    expect(kept.voided).toBe(true);
    expect(kept.voidReason).toBe('Not a real expense');
    expect(kept.voidedAt).toBeTruthy();
    expect(kept.voidedBy).toBe(ownerId);
    const voidRevision = (await db<{ transaction_id: string }>(
      `SELECT transaction_id FROM entry_revisions WHERE entry_id = $1 AND revision_type = 'void'`, [wrong.data.id],
    ))[0];
    expect(voidRevision.transaction_id).toMatch(/^txn_/);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM audit WHERE subject = $1 AND action = 'financial entry voided' AND transaction_id = $2`,
      [wrong.data.id, voidRevision.transaction_id],
    ))[0].n)).toBe(1);
  });

  it('keeps critical audit history and protects the last owner', async () => {
    const actions = (await db<{ action: string }>('SELECT action FROM audit ORDER BY id')).map((x) => x.action);
    for (const action of [
      'book opened',
      'delegated accounts assigned',
      'delegated transfer confirmed',
      'delegated transfer rejected',
      'delegated expense logged',
      'delegated expense assigned',
      'approval approved',
      'approval rejected',
      'evidence attached',
      'password reset',
      'entry corrected',
      'entry voided',
      'financial entry posted',
      'financial entry corrected',
      'financial entry voided',
      'delegated expense classified',
    ]) expect(actions).toContain(action);
    expect((await request(`/api/users/${ownerId}`, { method: 'DELETE', session: owner, body: {} })).response.status).toBe(400);
  });
});
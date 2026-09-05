import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = 43129;
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = '2026-09-05';
let child: ReturnType<typeof spawn> | null = null;
let serverLog = '';

type Session = { cookie: string };
type BookResponse = {
  businesses: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; businessId: string; opening: number }>;
  projects: Array<{ id: string; businessId: string }>;
  people: Array<{ id: string; businessId: string; kind: 'receivable' | 'payable' | 'salary'; opening: number; salary: number }>;
  loans: Array<{ id: string; fromBusiness: string; toBusiness: string; opening: number }>;
  entries: Array<{ id: string; voided: boolean; transactionId: string }>;
  balances: {
    totalCash: number;
    accounts: Record<string, number>;
    businesses: Record<string, number>;
    people: Record<string, number>;
    loans: Record<string, number>;
    projects: Record<string, number>;
  };
};

function sessionCookie(response: Response): string {
  const value = response.headers.get('set-cookie');
  if (!value) throw new Error('Expected session cookie');
  return value.split(';', 1)[0];
}

function money(value: unknown): number {
  const rounded = Math.round(Number(value) * 100) / 100;
  return rounded === 0 ? 0 : rounded;
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

async function runIntegrityCheck(): Promise<{ code: number | null; output: string }> {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'server/integrity-check.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: DATABASE_URL!,
      PGSSL: 'off',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout?.on('data', (chunk) => { output += chunk.toString(); });
  proc.stderr?.on('data', (chunk) => { output += chunk.toString(); });
  await once(proc, 'exit');
  return { code: proc.exitCode, output };
}

async function expectBookReconciles(book: BookResponse): Promise<void> {
  const accountRows = await db<{
    id: string;
    business_id: string;
    opening: string;
    moved: string;
  }>(`
    SELECT a.id, a.business_id, a.opening,
           COALESCE(SUM(CASE WHEN ef.active = true AND en.voided = false THEN ef.delta ELSE 0 END), 0) AS moved
      FROM accounts a
      LEFT JOIN effects ef ON ef.type = 'account' AND ef.target_id = a.id
      LEFT JOIN entries en ON en.id = ef.entry_id
     GROUP BY a.id, a.business_id, a.opening
     ORDER BY a.id
  `);

  const businessCash = new Map<string, number>();
  let totalCash = 0;
  for (const row of accountRows) {
    const expected = money(Number(row.opening) + Number(row.moved));
    expect(money(book.balances.accounts[row.id]), `account ${row.id}`).toBe(expected);
    businessCash.set(row.business_id, money((businessCash.get(row.business_id) ?? 0) + expected));
    totalCash = money(totalCash + expected);
  }
  expect(money(book.balances.totalCash)).toBe(totalCash);
  for (const business of book.businesses) {
    expect(money(book.balances.businesses[business.id]), `business ${business.id}`).toBe(
      money(businessCash.get(business.id) ?? 0),
    );
  }

  const peopleRows = await db<{
    id: string;
    kind: 'receivable' | 'payable' | 'salary';
    opening: string;
    salary: string;
    moved: string;
  }>(`
    SELECT p.id, p.kind, p.opening, p.salary,
           COALESCE(SUM(CASE WHEN ef.active = true AND en.voided = false THEN ef.delta ELSE 0 END), 0) AS moved
      FROM people p
      LEFT JOIN effects ef ON ef.type = 'person' AND ef.target_id = p.id
      LEFT JOIN entries en ON en.id = ef.entry_id
     GROUP BY p.id, p.kind, p.opening, p.salary
     ORDER BY p.id
  `);
  for (const row of peopleRows) {
    const opening = Number(row.opening);
    const moved = Number(row.moved);
    const expected = row.kind === 'receivable'
      ? money(opening + moved)
      : row.kind === 'payable'
        ? money(-(opening + moved))
        : money(opening + moved - Number(row.salary));
    expect(money(book.balances.people[row.id]), `person ${row.id}`).toBe(expected);
  }

  const projectRows = await db<{
    id: string;
    opening_received: string;
    received: string;
    spent: string;
  }>(`
    SELECT p.id,
           COALESCE((
             SELECT SUM(pr.amount) FROM project_receipts pr
              WHERE pr.project_id = p.id AND pr.entry_id IS NULL AND pr.voided_at IS NULL
           ), 0) AS opening_received,
           COALESCE((
             SELECT SUM(ef.delta)
               FROM effects ef JOIN entries en ON en.id = ef.entry_id
              WHERE ef.type = 'project' AND ef.target_id = p.id AND ef.active = true AND en.voided = false
           ), 0) AS received,
           COALESCE((
             SELECT SUM(ef.delta)
               FROM effects ef JOIN entries en ON en.id = ef.entry_id
              WHERE ef.type = 'cost' AND ef.target_id = p.id AND ef.active = true AND en.voided = false
           ), 0) AS spent
      FROM projects p
     ORDER BY p.id
  `);
  for (const row of projectRows) {
    const received = money(Number(row.opening_received) + Number(row.received));
    expect(money(book.balances.projects[row.id]), `project received ${row.id}`).toBe(received);
    const statement = await request(`/api/statement?type=project&id=${row.id}`, { session: owner });
    expect(statement.response.status).toBe(200);
    const rows = statement.data.rows as Array<{ running: number }>;
    const finalRunning = rows.length ? rows[rows.length - 1].running : received;
    expect(money(finalRunning), `project statement ${row.id}`).toBe(money(received - Number(row.spent)));
  }

  const loanRows = await db<{
    id: string;
    from_business: string;
    to_business: string;
    opening: string;
    moved: string;
  }>(`
    SELECT l.id, l.from_business, l.to_business, l.opening,
           COALESCE(SUM(CASE
             WHEN ef.active = true AND en.voided = false
              AND ef.from_business = l.from_business AND ef.to_business = l.to_business THEN ef.delta
             WHEN ef.active = true AND en.voided = false
              AND ef.from_business = l.to_business AND ef.to_business = l.from_business THEN -ef.delta
             ELSE 0 END), 0) AS moved
      FROM loans l
      LEFT JOIN effects ef ON ef.type = 'loan'
        AND ((ef.from_business = l.from_business AND ef.to_business = l.to_business)
          OR (ef.from_business = l.to_business AND ef.to_business = l.from_business))
      LEFT JOIN entries en ON en.id = ef.entry_id
     GROUP BY l.id, l.from_business, l.to_business, l.opening
     ORDER BY l.id
  `);
  for (const row of loanRows) {
    const expected = money(Number(row.opening) + Number(row.moved));
    expect(money(book.balances.loans[row.id]), `loan ${row.id}`).toBe(expected);
    const statement = await request(
      `/api/statement?type=loan&from=${row.from_business}&to=${row.to_business}`,
      { session: owner },
    );
    expect(statement.response.status).toBe(200);
    const rows = statement.data.rows as Array<{ running: number }>;
    const finalRunning = rows.length ? rows[rows.length - 1].running : -Number(row.opening);
    expect(money(finalRunning), `loan statement ${row.id}`).toBe(money(-expected));
  }

  for (const row of accountRows) {
    const statement = await request(`/api/statement?type=account&id=${row.id}`, { session: owner });
    const rows = statement.data.rows as Array<{ running: number }>;
    const finalRunning = rows.length ? rows[rows.length - 1].running : Number(row.opening);
    expect(money(finalRunning), `account statement ${row.id}`).toBe(money(book.balances.accounts[row.id]));
  }
  for (const row of peopleRows) {
    const statement = await request(`/api/statement?type=person&id=${row.id}`, { session: owner });
    const rows = statement.data.rows as Array<{ running: number }>;
    const opening = row.kind === 'receivable'
      ? Number(row.opening)
      : row.kind === 'payable'
        ? -Number(row.opening)
        : Number(row.opening) - Number(row.salary);
    const finalRunning = rows.length ? rows[rows.length - 1].running : opening;
    expect(money(finalRunning), `person statement ${row.id}`).toBe(money(book.balances.people[row.id]));
  }
}

const owner: Session = { cookie: '' };

describe.skipIf(!DATABASE_URL)('financial end-to-end reconciliation', () => {
  const delegate: Session = { cookie: '' };
  let ownerId = '';
  let delegateId = '';
  let alpha = '';
  let beta = '';
  let ownerCash = '';
  let wallet = '';
  let betaCash = '';
  let project = '';
  let supplier = '';
  let borrower = '';
  let worker = '';
  let delegatedExpense = '';
  let correctedEntry = '';
  let voidedEntry = '';

  beforeAll(async () => {
    await resetToLegacyShape();
    child = spawn(process.execPath, ['--import', 'tsx', 'server/start.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: DATABASE_URL!,
        SESSION_SECRET: 'phase-1-financial-e2e-secret-that-is-long-enough',
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

  it('executes a realistic mixed financial workflow through the HTTP API', async () => {
    const opened = await request('/api/first-owner', {
      method: 'POST', body: { username: 'Owner One', password: 'OwnerPass!2026' },
    });
    expect(opened.response.status).toBe(201);
    owner.cookie = sessionCookie(opened.response);
    ownerId = opened.data.user.id;

    alpha = (await request('/api/businesses', {
      method: 'POST', session: owner, body: { name: 'Alpha Construction' },
    })).data.id;
    beta = (await request('/api/businesses', {
      method: 'POST', session: owner, body: { name: 'Beta Trading' },
    })).data.id;
    ownerCash = (await request('/api/accounts', {
      method: 'POST', session: owner, body: { name: 'Alpha Main Cash', businessId: alpha, opening: 10000 },
    })).data.id;
    wallet = (await request('/api/accounts', {
      method: 'POST', session: owner, body: { name: 'Site Wallet', businessId: alpha, opening: 0 },
    })).data.id;
    betaCash = (await request('/api/accounts', {
      method: 'POST', session: owner, body: { name: 'Beta Cash', businessId: beta, opening: 2000 },
    })).data.id;
    project = (await request('/api/projects', {
      method: 'POST', session: owner,
      body: { name: 'Warehouse Build', scope: 'Construction', businessId: alpha, opening: 250 },
    })).data.id;
    supplier = (await request('/api/people', {
      method: 'POST', session: owner,
      body: { name: 'Steel Supplier', businessId: alpha, opening: 300, kind: 'payable', role: 'Supplier', salary: 0 },
    })).data.id;
    borrower = (await request('/api/people', {
      method: 'POST', session: owner,
      body: { name: 'Employee Loan', businessId: alpha, opening: 400, kind: 'receivable', role: 'Loan', salary: 0 },
    })).data.id;
    worker = (await request('/api/people', {
      method: 'POST', session: owner,
      body: { name: 'Site Worker', businessId: alpha, opening: 0, kind: 'salary', role: 'Staff', salary: 500 },
    })).data.id;

    const createdDelegate = await request('/api/users', {
      method: 'POST', session: owner,
      body: { username: 'Site User', password: 'DelegatePass!2026', role: 'entry' },
    });
    expect(createdDelegate.response.status).toBe(201);
    delegateId = createdDelegate.data.user.id;
    expect((await request(`/api/delegation/users/${delegateId}/accounts`, {
      method: 'PUT', session: owner, body: { accountIds: [wallet] },
    })).response.status).toBe(200);
    const login = await request('/api/login', {
      method: 'POST', body: { username: 'SITEUSER', password: 'DelegatePass!2026' },
    });
    expect(login.response.status).toBe(200);
    delegate.cookie = sessionCookie(login.response);

    const handoff = await request('/api/delegation/transfers', {
      method: 'POST', session: owner,
      body: { fromAccountId: ownerCash, toAccountId: wallet, amount: 1000, purpose: 'Site float', occurredOn: '2026-09-01' },
    });
    expect(handoff.response.status).toBe(201);
    expect((await request(`/api/delegation/transfers/${handoff.data.id}/confirm`, {
      method: 'POST', session: delegate, body: {},
    })).response.status).toBe(200);

    const delegatedInput = {
      occurredOn: '2026-09-02', kind: 'expense', amount: 125, purpose: 'Cement', raw: 'cement',
      accountId: wallet, clientRef: 'phase1-delegated-cement',
    };
    const [first, duplicate] = await Promise.all([
      request('/api/entries', { method: 'POST', session: delegate, body: delegatedInput }),
      request('/api/entries', { method: 'POST', session: delegate, body: delegatedInput }),
    ]);
    expect(first.response.status).toBe(201);
    expect(duplicate.response.status).toBe(201);
    expect(first.data.id).toBe(duplicate.data.id);
    delegatedExpense = first.data.id;
    expect((await request('/api/delegation/expense-reviews/assign', {
      method: 'POST', session: owner,
      body: { entryIds: [delegatedExpense], businessId: alpha, projectId: project, category: 'Materials' },
    })).response.status).toBe(200);

    const entries = [
      { occurredOn: '2026-09-02', kind: 'expense', amount: 200, purpose: 'Concrete', raw: '', accountId: ownerCash, projectId: project, clientRef: 'phase1-concrete' },
      { occurredOn: '2026-09-02', kind: 'credit_purchase', amount: 300, purpose: 'Steel on credit', raw: '', personId: supplier, projectId: project, clientRef: 'phase1-steel-credit' },
      { occurredOn: '2026-09-03', kind: 'supplier_payment', amount: 100, purpose: 'Supplier payment', raw: '', accountId: ownerCash, personId: supplier, clientRef: 'phase1-supplier-pay' },
      { occurredOn: '2026-09-03', kind: 'person_loan', amount: 250, purpose: 'Employee advance', raw: '', accountId: ownerCash, personId: borrower, clientRef: 'phase1-person-loan' },
      { occurredOn: '2026-09-03', kind: 'salary', amount: 150, purpose: 'Salary advance', raw: '', accountId: ownerCash, personId: worker, clientRef: 'phase1-salary' },
      { occurredOn: '2026-09-04', kind: 'receipt', amount: 600, purpose: 'Client receipt', raw: '', accountId: ownerCash, projectId: project, clientRef: 'phase1-receipt' },
      { occurredOn: '2026-08-15', kind: 'receipt', amount: 450, purpose: 'Historical client receipt', raw: '', accountId: ownerCash, projectId: project, historical: true, clientRef: 'phase1-historical-receipt' },
      { occurredOn: '2026-09-04', kind: 'transfer', amount: 500, purpose: 'Fund Beta', raw: '', accountId: ownerCash, toAccountId: betaCash, clientRef: 'phase1-intercompany-transfer' },
      { occurredOn: '2026-09-04', kind: 'expense', amount: 80, purpose: 'Paid for Alpha', raw: '', accountId: betaCash, forBusiness: alpha, projectId: project, clientRef: 'phase1-cross-business-expense' },
    ];
    for (const entry of entries) {
      const posted = await request('/api/entries', { method: 'POST', session: owner, body: entry });
      expect(posted.response.status, `${entry.kind}: ${entry.purpose}`).toBe(201);
    }

    const wrong = await request('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'expense', amount: 220, purpose: 'Correct me', raw: '', accountId: ownerCash, projectId: project, clientRef: 'phase1-correct-me' },
    });
    correctedEntry = wrong.data.id;
    expect((await request(`/api/entries/${correctedEntry}`, {
      method: 'PATCH', session: owner, body: { amount: 175 },
    })).response.status).toBe(200);

    const notReal = await request('/api/entries', {
      method: 'POST', session: owner,
      body: { occurredOn: DAY, kind: 'expense', amount: 60, purpose: 'Void me', raw: '', accountId: ownerCash, projectId: project, clientRef: 'phase1-void-me' },
    });
    voidedEntry = notReal.data.id;
    expect((await request(`/api/entries/${voidedEntry}/void`, {
      method: 'POST', session: owner, body: { reason: 'Test reversal' },
    })).response.status).toBe(200);

    const asOfAugust = (await request('/api/book?on=2026-08-31', { session: owner })).data as BookResponse;
    expect(money(asOfAugust.balances.accounts[ownerCash])).toBe(10000);
    expect(money(asOfAugust.balances.projects[project])).toBe(700);

    const current = (await request('/api/book', { session: owner })).data as BookResponse;
    expect(current.entries.find((entry) => entry.id === voidedEntry)?.voided).toBe(true);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM entries WHERE client_ref = 'phase1-delegated-cement'`,
    ))[0].n)).toBe(1);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM entry_revisions WHERE entry_id = $1 AND revision_type = 'classification'`, [delegatedExpense],
    ))[0].n)).toBe(1);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM entry_revisions WHERE entry_id = $1 AND revision_type = 'correction'`, [correctedEntry],
    ))[0].n)).toBe(1);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM entry_revisions WHERE entry_id = $1 AND revision_type = 'void'`, [voidedEntry],
    ))[0].n)).toBe(1);
  });

  it('reconstructs every displayed balance and statement from raw database state', async () => {
    const response = await request('/api/book', { session: owner });
    expect(response.response.status).toBe(200);
    await expectBookReconciles(response.data as BookResponse);
  });

  it('proves transaction lineage, immutable revisions, and production integrity checks', async () => {
    const entryAudit = await db<{ id: string; transaction_id: string; n: string }>(`
      SELECT en.id, en.transaction_id, count(a.id)::text AS n
        FROM entries en
        LEFT JOIN audit a
          ON a.transaction_id = en.transaction_id
         AND a.subject = en.id
         AND a.action = 'financial entry posted'
       GROUP BY en.id, en.transaction_id
       ORDER BY en.id
    `);
    expect(entryAudit.length).toBeGreaterThan(8);
    expect(new Set(entryAudit.map((row) => row.transaction_id)).size).toBe(entryAudit.length);
    for (const row of entryAudit) {
      expect(row.transaction_id).toMatch(/^txn_/);
      expect(Number(row.n), `posted audit for ${row.id}`).toBe(1);
    }

    const revisionAudit = await db<{ entry_id: string; revision_type: string; transaction_id: string; n: string }>(`
      SELECT r.entry_id, r.revision_type, r.transaction_id, count(a.id)::text AS n
        FROM entry_revisions r
        LEFT JOIN audit a
          ON a.transaction_id = r.transaction_id
         AND a.subject = r.entry_id
         AND a.action = CASE r.revision_type
           WHEN 'classification' THEN 'delegated expense classified'
           WHEN 'correction' THEN 'financial entry corrected'
           WHEN 'void' THEN 'financial entry voided'
         END
       GROUP BY r.entry_id, r.revision_type, r.transaction_id
       ORDER BY r.entry_id, r.revision_type, r.transaction_id
    `);
    expect(revisionAudit.map((row) => row.revision_type)).toEqual(
      expect.arrayContaining(['classification', 'correction', 'void']),
    );
    for (const row of revisionAudit) {
      expect(row.transaction_id).toMatch(/^txn_/);
      expect(Number(row.n), `${row.revision_type} audit for ${row.entry_id}`).toBe(1);
    }

    const revisionSnapshots = await db<{ revision_type: string; before_entry: any; after_entry: any; before_effects: any; after_effects: any }>(`
      SELECT revision_type, before_entry, after_entry, before_effects, after_effects
        FROM entry_revisions
       WHERE entry_id = ANY($1::text[])
       ORDER BY id
    `, [[delegatedExpense, correctedEntry, voidedEntry]]);
    expect(revisionSnapshots).toHaveLength(3);
    for (const row of revisionSnapshots) {
      expect(row.before_entry).toBeTruthy();
      expect(row.after_entry).toBeTruthy();
      expect(Array.isArray(row.before_effects)).toBe(true);
      expect(Array.isArray(row.after_effects)).toBe(true);
    }

    const integrity = await runIntegrityCheck();
    expect(integrity.code, integrity.output).toBe(0);
    expect(integrity.output).toContain('"ok": true');
    expect(integrity.output).toContain('"errors": 0');

    expect(ownerId).toBeTruthy();
  });
});

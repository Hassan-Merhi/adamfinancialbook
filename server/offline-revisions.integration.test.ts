import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { offlineEffectSignature } from '../shared/offline-conflict.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = 43141;
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = '2026-09-06';
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

function revisionContext(entry: any) {
  return {
    version: 1,
    capturedAt: '2026-09-06T09:45:00.000Z',
    entry: {
      id: entry.id,
      occurredOn: entry.occurredOn,
      kind: entry.kind,
      amount: Number(entry.amount),
      purpose: entry.purpose ?? '',
      raw: entry.raw ?? '',
      accountId: entry.accountId ?? null,
      toAccountId: entry.toAccountId ?? null,
      projectId: entry.projectId ?? null,
      personId: entry.personId ?? null,
      forBusiness: entry.forBusiness ?? null,
      historical: Boolean(entry.historical),
      linkReceiptId: entry.linkReceiptId ?? null,
      correctedFrom: entry.correctedFrom == null ? null : Number(entry.correctedFrom),
      correctedAt: entry.correctedAt ?? null,
      voided: Boolean(entry.voided),
      voidedAt: entry.voidedAt ?? null,
      effectSignature: offlineEffectSignature(entry.effects ?? []),
    },
  };
}

describe.skipIf(!DATABASE_URL)('Offline Correct + Void Phase 1 PostgreSQL safety', () => {
  const owner: Session = { cookie: '' };
  let business = '';
  let cash = '';

  beforeAll(async () => {
    await resetToLegacyShape();
    child = spawn(process.execPath, ['--import', 'tsx', 'server/start.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: DATABASE_URL!,
        SESSION_SECRET: 'offline-revision-phase-1-integration-secret-long-enough',
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

    business = (await request('/api/businesses', {
      method: 'POST', session: owner, body: { name: 'Revision Test Business' },
    })).data.id;
    cash = (await request('/api/accounts', {
      method: 'POST', session: owner,
      body: { name: 'Cash', businessId: business, opening: 1000 },
    })).data.id;
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

  async function addExpense(amount: number, ref: string) {
    const saved = await request('/api/entries', {
      method: 'POST', session: owner,
      body: {
        occurredOn: DAY,
        kind: 'expense',
        amount,
        purpose: `Expense ${ref}`,
        raw: `Expense ${ref}`,
        accountId: cash,
        clientRef: ref,
      },
    });
    expect(saved.response.status).toBe(201);
    return saved.data.id as string;
  }

  async function entryFromBook(id: string) {
    const loaded = await request('/api/book', { session: owner });
    expect(loaded.response.status).toBe(200);
    return { entry: loaded.data.entries.find((item: any) => item.id === id), book: loaded.data };
  }

  it('corrects exactly once, replays safely, and rejects reuse for a different correction', async () => {
    const id = await addExpense(20, 'online-revision-base-1');
    const before = await entryFromBook(id);
    const body = {
      amount: 30,
      clientRef: 'q_offline_correct_once',
      offlineContext: revisionContext(before.entry),
    };

    const corrected = await request(`/api/entries/${id}`, { method: 'PATCH', session: owner, body });
    expect(corrected.response.status).toBe(200);
    expect(corrected.data.replay).toBe(false);

    const replay = await request(`/api/entries/${id}`, { method: 'PATCH', session: owner, body });
    expect(replay.response.status).toBe(200);
    expect(replay.data.replay).toBe(true);

    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM entry_revisions WHERE client_ref = $1', [body.clientRef],
    ))[0].n)).toBe(1);

    const reused = await request(`/api/entries/${id}`, {
      method: 'PATCH', session: owner, body: { ...body, amount: 31 },
    });
    expect(reused.response.status).toBe(409);
    expect(reused.data.code).toBe('OFFLINE_CONFLICT_IDEMPOTENCY_KEY_REUSED');

    const after = await entryFromBook(id);
    expect(after.entry.amount).toBe(30);
    expect(after.entry.correctedFrom).toBe(20);
    expect(after.book.balances.accounts[cash]).toBe(970);
  });

  it('refuses a stale offline revision after the server entry changed', async () => {
    const id = await addExpense(40, 'online-revision-base-2');
    const captured = await entryFromBook(id);

    const onlineCorrection = await request(`/api/entries/${id}`, {
      method: 'PATCH', session: owner, body: { amount: 45 },
    });
    expect(onlineCorrection.response.status).toBe(200);

    const staleVoid = await request(`/api/entries/${id}/void`, {
      method: 'POST', session: owner,
      body: {
        reason: 'Stale offline void',
        clientRef: 'q_offline_stale_void',
        offlineContext: revisionContext(captured.entry),
      },
    });
    expect(staleVoid.response.status).toBe(409);
    expect(staleVoid.data.code).toBe('OFFLINE_CONFLICT_ENTRY_CHANGED');
    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM entry_revisions WHERE client_ref = $1', ['q_offline_stale_void'],
    ))[0].n)).toBe(0);
  });

  it('voids exactly once and immediately reverses the accounting effect', async () => {
    const id = await addExpense(50, 'online-revision-base-3');
    const captured = await entryFromBook(id);
    const beforeBalance = Number(captured.book.balances.accounts[cash]);
    const body = {
      reason: 'Duplicate expense',
      clientRef: 'q_offline_void_once',
      offlineContext: revisionContext(captured.entry),
    };

    const voided = await request(`/api/entries/${id}/void`, { method: 'POST', session: owner, body });
    expect(voided.response.status).toBe(200);
    expect(voided.data.replay).toBe(false);

    const replay = await request(`/api/entries/${id}/void`, { method: 'POST', session: owner, body });
    expect(replay.response.status).toBe(200);
    expect(replay.data.replay).toBe(true);

    const after = await entryFromBook(id);
    expect(after.entry.voided).toBe(true);
    expect(after.entry.voidReason).toBe('Duplicate expense');
    expect(after.book.balances.accounts[cash]).toBe(beforeBalance + 50);
    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM entry_revisions WHERE client_ref = $1', [body.clientRef],
    ))[0].n)).toBe(1);
    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM effects WHERE entry_id = $1 AND active = true', [id],
    ))[0].n)).toBe(0);
  });
});

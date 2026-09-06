import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = 43137;
const BASE = `http://127.0.0.1:${PORT}`;
let child: ReturnType<typeof spawn> | null = null;
let serverLog = '';

type Session = { cookie: string };

function sessionCookie(response: Response): string {
  const value = response.headers.get('set-cookie');
  if (!value) throw new Error('Expected session cookie');
  return value.split(';', 1)[0];
}

async function request(path: string, options: { method?: string; session?: Session; body?: unknown } = {}) {
  const method = options.method ?? 'GET';
  const headers = new Headers();
  if (options.session) headers.set('cookie', options.session.cookie);
  if (method !== 'GET' && method !== 'HEAD' && path !== '/api/login' && path !== '/api/first-owner') headers.set('x-book', '1');
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

async function upload(entryId: string, attachmentId: string, session: Session, bytes: Uint8Array) {
  const response = await fetch(`${BASE}/api/delegation/attachments/entry/${encodeURIComponent(entryId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      cookie: session.cookie,
      'content-type': 'image/png',
      'x-book': '1',
      'x-offline-attachment-id': attachmentId,
    },
    body: bytes,
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

function png(lastByte = 1): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, lastByte,
  ]);
}

describe.skipIf(!DATABASE_URL)('Offline Phase 5 receipt upload safety', () => {
  const owner: Session = { cookie: '' };
  let entryId = '';

  beforeAll(async () => {
    await resetToLegacyShape();
    child = spawn(process.execPath, ['--import', 'tsx', 'server/start.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: DATABASE_URL!,
        SESSION_SECRET: 'offline-phase-5-attachment-secret-long-enough',
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

    const business = (await request('/api/businesses', {
      method: 'POST', session: owner, body: { name: 'Phase 5 Evidence' },
    })).data.id;
    const account = (await request('/api/accounts', {
      method: 'POST', session: owner, body: { name: 'Receipt Cash', businessId: business, opening: 1000 },
    })).data.id;
    const entry = await request('/api/entries', {
      method: 'POST', session: owner,
      body: {
        occurredOn: '2026-09-06',
        kind: 'expense',
        amount: 25,
        purpose: 'Offline receipt test',
        raw: 'Offline receipt test',
        accountId: account,
        clientRef: 'q_phase5_receipt_entry',
      },
    });
    expect(entry.response.status).toBe(201);
    entryId = entry.data.id;
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

  it('resolves a synced clientRef and makes uncertain receipt replay exactly-once', async () => {
    const resolved = await request('/api/offline/entries/by-client-ref/q_phase5_receipt_entry', { session: owner });
    expect(resolved.response.status).toBe(200);
    expect(resolved.data.id).toBe(entryId);

    const attachmentId = 'att_sync_phase5_stable';
    const first = await upload(entryId, attachmentId, owner, png(1));
    expect(first.response.status).toBe(201);
    expect(first.data).toMatchObject({ id: attachmentId, deduplicated: false });

    // Simulate a phone that lost the first HTTP response and sends the same
    // durable blob again. The primary key and byte comparison must return the
    // original attachment instead of creating or notifying twice.
    const replay = await upload(entryId, attachmentId, owner, png(1));
    expect(replay.response.status).toBe(200);
    expect(replay.data).toMatchObject({ id: attachmentId, deduplicated: true });

    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM attachments WHERE id = $1', [attachmentId],
    ))[0].n)).toBe(1);
    expect(Number((await db<{ n: string }>(
      `SELECT count(*) AS n FROM audit WHERE action = 'evidence attached' AND subject = $1`, [attachmentId],
    ))[0].n)).toBe(1);

    const reused = await upload(entryId, attachmentId, owner, png(2));
    expect(reused.response.status).toBe(409);
    expect(reused.data.code).toBe('OFFLINE_ATTACHMENT_ID_REUSED');
    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM attachments WHERE id = $1', [attachmentId],
    ))[0].n)).toBe(1);
  });

  it('keeps unsupported evidence out of PostgreSQL', async () => {
    const attachmentId = 'att_sync_bad_magic';
    const bad = await upload(entryId, attachmentId, owner, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(bad.response.status).toBe(415);
    expect(Number((await db<{ n: string }>(
      'SELECT count(*) AS n FROM attachments WHERE id = $1', [attachmentId],
    ))[0].n)).toBe(0);
  });
});

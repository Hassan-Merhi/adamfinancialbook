import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { offlineSetupEntityId } from '../shared/offline-setup.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = 43142;
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
  if (options.body !== undefined) { headers.set('content-type', 'application/json'); body = JSON.stringify(options.body); }
  const response = await fetch(`${BASE}${path}`, { method, headers, body });
  const text = await response.text();
  let data: any = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { response, data };
}

async function db<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: false });
  await client.connect();
  try { return (await client.query(sql, params)).rows as T[]; } finally { await client.end(); }
}

async function resetToLegacyShape(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: false });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await client.query(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  } finally { await client.end(); }
}

async function waitUntilHealthy(): Promise<void> {
  for (let i = 0; i < 150; i += 1) {
    if (child && child.exitCode !== null) throw new Error(`Server exited before health check:\n${serverLog}`);
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server never became healthy:\n${serverLog}`);
}

describe.skipIf(!DATABASE_URL)('Offline safe setup Phase 2 PostgreSQL safety', () => {
  const owner: Session = { cookie: '' };

  beforeAll(async () => {
    await resetToLegacyShape();
    child = spawn(process.execPath, ['--import', 'tsx', 'server/start.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: DATABASE_URL!, SESSION_SECRET: 'offline-safe-setup-phase-2-integration-secret', PGSSL: 'off', PGPOOL_MAX: '4', PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => { serverLog += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { serverLog += chunk.toString(); });
    await waitUntilHealthy();
    const opened = await request('/api/first-owner', { method: 'POST', body: { email: 'owner@example.com', password: 'OwnerPass!2026' } });
    expect(opened.response.status).toBe(201);
    owner.cookie = sessionCookie(opened.response);
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
      try { await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); } finally { await client.end(); }
    }
  }, 15_000);

  it('creates and replays a business exactly once with one required audit line', async () => {
    const body = { offlineOperation: 'setup_create', setupType: 'business', name: 'Offline Business', clientRef: 'q_setup_business_1' };
    const id = offlineSetupEntityId(body as any);
    const first = await request('/api/businesses', { method: 'POST', session: owner, body });
    const replay = await request('/api/businesses', { method: 'POST', session: owner, body });
    expect(first.response.status).toBe(201);
    expect(replay.response.status).toBe(200);
    expect(first.data.id).toBe(id);
    expect(replay.data.id).toBe(id);
    expect(Number((await db<{ n: number }>('SELECT count(*)::int AS n FROM businesses WHERE id = $1', [id]))[0].n)).toBe(1);
    expect(Number((await db<{ n: number }>("SELECT count(*)::int AS n FROM audit WHERE subject = $1 AND action = 'offline setup business created'", [id]))[0].n)).toBe(1);
  });

  it('serializes concurrent replay and preserves opening balances/project receipts', async () => {
    const businessId = offlineSetupEntityId({ setupType: 'business', clientRef: 'q_setup_business_1' } as any);
    const accountBody = { offlineOperation: 'setup_create', setupType: 'account', name: 'Offline Cash', businessId, opening: 125, clientRef: 'q_setup_account_1' };
    const [a, b] = await Promise.all([
      request('/api/accounts', { method: 'POST', session: owner, body: accountBody }),
      request('/api/accounts', { method: 'POST', session: owner, body: accountBody }),
    ]);
    expect([a.response.status, b.response.status].sort()).toEqual([200, 201]);
    const accountId = offlineSetupEntityId(accountBody as any);
    expect(Number((await db<{ n: number }>('SELECT count(*)::int AS n FROM accounts WHERE id = $1', [accountId]))[0].n)).toBe(1);

    const projectBody = { offlineOperation: 'setup_create', setupType: 'project', name: 'Offline Project', businessId, opening: 300, scope: '', clientRef: 'q_setup_project_1' };
    expect((await request('/api/projects', { method: 'POST', session: owner, body: projectBody })).response.status).toBe(201);
    const projectId = offlineSetupEntityId(projectBody as any);
    expect(Number((await db<{ n: number }>('SELECT count(*)::int AS n FROM project_receipts WHERE project_id = $1 AND entry_id IS NULL', [projectId]))[0].n)).toBe(1);

    const personBody = { offlineOperation: 'setup_create', setupType: 'person', name: 'Offline Supplier', businessId, kind: 'payable', opening: 75, salary: 0, role: 'Supplier', clientRef: 'q_setup_person_1' };
    expect((await request('/api/people', { method: 'POST', session: owner, body: personBody })).response.status).toBe(201);
    const reminderBody = { offlineOperation: 'setup_create', setupType: 'reminder', what: 'Offline reminder', amount: 9, accountId, note: '', clientRef: 'q_setup_reminder_1' };
    expect((await request('/api/reminders', { method: 'POST', session: owner, body: reminderBody })).response.status).toBe(201);

    const book = (await request('/api/book', { session: owner })).data;
    expect(book.balances.accounts[accountId]).toBe(125);
    expect(book.balances.projects[projectId]).toBe(300);
    expect(book.balances.people[offlineSetupEntityId(personBody as any)]).toBe(-75);
    expect(book.reminders.some((item: any) => item.id === offlineSetupEntityId(reminderBody as any))).toBe(true);
  });

  it('rejects idempotency-key reuse and missing confirmed parents without partial writes', async () => {
    const mismatched = await request('/api/businesses', { method: 'POST', session: owner, body: { offlineOperation: 'setup_create', setupType: 'business', name: 'Different Name', clientRef: 'q_setup_business_1' } });
    expect(mismatched.response.status).toBe(409);
    expect(mismatched.data.code).toBe('OFFLINE_CONFLICT_IDEMPOTENCY_KEY_REUSED');

    const missing = await request('/api/projects', { method: 'POST', session: owner, body: { offlineOperation: 'setup_create', setupType: 'project', name: 'Blocked Project', businessId: 'biz_missing', opening: 0, scope: '', clientRef: 'q_setup_missing_parent' } });
    expect(missing.response.status).toBe(409);
    expect(missing.data.code).toBe('OFFLINE_CONFLICT_TARGET_MISSING');
    const blockedId = offlineSetupEntityId({ setupType: 'project', clientRef: 'q_setup_missing_parent' } as any);
    expect(Number((await db<{ n: number }>('SELECT count(*)::int AS n FROM projects WHERE id = $1', [blockedId]))[0].n)).toBe(0);
  });
});

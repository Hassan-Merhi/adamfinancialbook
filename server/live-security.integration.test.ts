import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = 43141;
const BASE = `http://127.0.0.1:${PORT}`;
let child: ReturnType<typeof spawn> | null = null;
let serverLog = '';

type Session = { cookie: string };
type Sse = {
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array>;
};

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
  } finally {
    await client.end();
  }
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

async function openSse(session: Session, clientId: string): Promise<Sse> {
  const controller = new AbortController();
  const response = await fetch(`${BASE}/api/live-updates?client=${encodeURIComponent(clientId)}`, {
    headers: { cookie: session.cookie },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    controller.abort();
    throw new Error(`Could not open SSE stream: ${response.status}`);
  }
  return { controller, reader: response.body.getReader() };
}

async function readEvent(sse: Sse, wanted: string, timeoutMs = 7_000): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const result = await Promise.race([
      sse.reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for SSE event ${wanted}.`)), remaining);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });

    if (result.done) throw new Error(`SSE stream ended before event ${wanted}.`);
    buffer += decoder.decode(result.value, { stream: true });
    let split = buffer.indexOf('\n\n');
    while (split >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      if (block.split('\n').some((line) => line === `event: ${wanted}`)) return block;
      split = buffer.indexOf('\n\n');
    }
  }
  throw new Error(`Timed out waiting for SSE event ${wanted}.`);
}

function eventData(block: string): any {
  const line = block.split('\n').find((part) => part.startsWith('data: '));
  if (!line) throw new Error(`SSE event did not contain data: ${block}`);
  return JSON.parse(line.slice('data: '.length));
}

describe.skipIf(!DATABASE_URL)('Phase 6 live security PostgreSQL/SSE certification', () => {
  const owner: Session = { cookie: '' };
  const delegate: Session = { cookie: '' };
  let delegateId = '';
  let ownerSse: Sse | null = null;
  let delegateSse: Sse | null = null;

  beforeAll(async () => {
    await resetToLegacyShape();
    child = spawn(process.execPath, ['--import', 'tsx', 'server/start.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: DATABASE_URL!,
        SESSION_SECRET: 'phase-6-live-security-integration-secret-long-enough',
        PGSSL: 'off',
        PGPOOL_MAX: '6',
        PORT: String(PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => { serverLog += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { serverLog += chunk.toString(); });
    await waitUntilHealthy();

    const opened = await request('/api/first-owner', {
      method: 'POST',
      body: { username: 'liveowner', password: 'OwnerPass!2026' },
    });
    expect(opened.response.status).toBe(201);
    owner.cookie = sessionCookie(opened.response);

    const created = await request('/api/users', {
      method: 'POST',
      session: owner,
      body: { username: 'livedelegate', password: 'DelegatePass!2026', role: 'entry' },
    });
    expect(created.response.status).toBe(201);
    delegateId = created.data.user.id;

    const login = await request('/api/login', {
      method: 'POST',
      body: { username: 'livedelegate', password: 'DelegatePass!2026' },
    });
    expect(login.response.status).toBe(200);
    delegate.cookie = sessionCookie(login.response);

    ownerSse = await openSse(owner, 'owner-certification-tab');
    delegateSse = await openSse(delegate, 'delegate-certification-tab');
  }, 30_000);

  afterAll(async () => {
    ownerSse?.controller.abort();
    delegateSse?.controller.abort();
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]).catch(() => undefined);
    }
  });

  it('propagates protected access changes and immediately terminates revoked live authority', async () => {
    expect(ownerSse).not.toBeNull();
    expect(delegateSse).not.toBeNull();

    const disabled = await request(`/api/users/${delegateId}`, {
      method: 'DELETE',
      session: owner,
    });
    expect(disabled.response.status).toBe(200);

    // Moving the mutation observer above protectedSecurityRouter is what makes
    // this owner invalidation visible for a route that terminates in that router.
    const ownerMutation = eventData(await readEvent(ownerSse!, 'mutation'));
    expect(ownerMutation.book).toBe(false);
    expect(ownerMutation.dashboard).toBe(true);
    expect(ownerMutation.topics).toEqual(expect.arrayContaining(['approvals', 'access', 'history']));
    expect(ownerMutation).not.toHaveProperty('audience');
    expect(ownerMutation).not.toHaveProperty('sourceClientId');

    const sessionRefresh = eventData(await readEvent(delegateSse!, 'session'));
    expect(sessionRefresh.state).toBe('refresh');
    expect(typeof sessionRefresh.at).toBe('number');
    expect(Object.keys(sessionRefresh).sort()).toEqual(['at', 'state']);

    const rejected = await request('/api/overview', { session: delegate });
    expect(rejected.response.status).toBe(401);
    expect(rejected.data.error).toMatch(/sign in/i);
  }, 15_000);
});

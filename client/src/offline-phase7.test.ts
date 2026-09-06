import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NotSignedIn } from './api';
import {
  flushOutbox,
  initializeOfflineStorage,
  lastUser,
  outbox,
  resetOfflineStorageForTests,
} from './offline';
import { offlineSyncState } from './offline-sync-state';
import {
  attachmentQueue,
  resetOfflineAttachmentsForTests,
} from './offline-attachments';
import type { EntryInput } from '../../shared/types';

const NOW = Date.parse('2026-09-06T09:00:00.000Z');
const ACTIVE_USER = { id: 'phase7-user', email: 'phase7@example.com', role: 'entry' as const };

function input(index: number, amount = 1): EntryInput {
  return {
    occurredOn: '2026-09-06',
    kind: 'expense',
    amount,
    purpose: `Offline chaos ${index}`,
    raw: `Offline chaos ${index}`,
    accountId: 'cash',
  };
}

function refOf(item: ReturnType<typeof outbox.records>[number]): string {
  return String(item.input.clientRef ?? item.id);
}

function queuedRefs(): Set<string> {
  return new Set(outbox.records().map(refOf));
}

function expectAcceptedOrQueuedExactlyOnce(original: readonly string[], accepted: ReadonlySet<string>) {
  const queued = queuedRefs();
  for (const ref of original) {
    expect(Number(accepted.has(ref)) + Number(queued.has(ref))).toBe(1);
  }
  expect(new Set([...accepted, ...queued]).size).toBe(original.length);
}

function image(name: string): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])], name, { type: 'image/png' });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Offline Phase 7 reconnect / chaos certification', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal('navigator', { onLine: true });
    await resetOfflineAttachmentsForTests();
    await resetOfflineStorageForTests();
    await initializeOfflineStorage();
    await lastUser.save(ACTIVE_USER);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetOfflineAttachmentsForTests();
    await resetOfflineStorageForTests();
  });

  it('holds 1, 100, and 1,000 queued financial writes, then drains them exactly once', async () => {
    const refs: string[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      const item = await outbox.add(input(index));
      refs.push(String(item.input.clientRef ?? item.id));
      if (index === 0) expect(outbox.all()).toHaveLength(1);
      if (index === 99) expect(outbox.all()).toHaveLength(100);
      if (index === 999) expect(outbox.all()).toHaveLength(1_000);
    }

    expect(new Set(refs).size).toBe(1_000);
    const accepted = new Set<string>();
    const sent = await flushOutbox(async (entry) => {
      const ref = String(entry.clientRef);
      expect(accepted.has(ref)).toBe(false);
      accepted.add(ref);
      return { id: `server-${accepted.size}` };
    }, { now: () => NOW, schedule: false });

    expect(sent).toBe(1_000);
    expect(accepted.size).toBe(1_000);
    expect(outbox.all()).toHaveLength(0);
    expectAcceptedOrQueuedExactlyOnce(refs, accepted);
  }, 30_000);

  it('coalesces a reconnect storm so duplicate online events cannot duplicate financial writes', async () => {
    const items = [];
    for (let index = 0; index < 100; index += 1) items.push(await outbox.add(input(index)));
    const refs = items.map((item) => String(item.input.clientRef ?? item.id));
    const accepted = new Set<string>();
    const send = vi.fn(async (entry: EntryInput) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      accepted.add(String(entry.clientRef));
      return { ok: true };
    });

    const results = await Promise.all(Array.from({ length: 25 }, () =>
      flushOutbox(send, { now: () => NOW, schedule: false })));

    expect(results.every((count) => count === 100)).toBe(true);
    expect(send).toHaveBeenCalledTimes(100);
    expect(accepted.size).toBe(100);
    expect(outbox.all()).toHaveLength(0);
    expectAcceptedOrQueuedExactlyOnce(refs, accepted);
  }, 15_000);

  it('survives a server deploy in the middle of a batch and resumes in strict order', async () => {
    const items = [];
    for (let index = 0; index < 5; index += 1) items.push(await outbox.add(input(index, 10)));
    const refs = items.map((item) => String(item.input.clientRef ?? item.id));
    const thirdRef = refs[2];
    const accepted = new Set<string>();
    const attempts: string[] = [];
    let deployRestart = true;

    const send = async (entry: EntryInput) => {
      const ref = String(entry.clientRef);
      attempts.push(ref);
      if (ref === thirdRef && deployRestart) {
        deployRestart = false;
        throw new ApiError('Server restarting', 503, 'DEPLOY_RESTART');
      }
      accepted.add(ref);
      return { id: `server-${ref}` };
    };

    expect(await flushOutbox(send, { now: () => NOW, schedule: false })).toBe(2);
    expect(outbox.records().map(refOf)).toEqual(refs.slice(2));
    expect(outbox.status(items[2].id).status).toBe('retry_wait');
    expect(outbox.status(items[3].id).status).toBe('pending');
    expectAcceptedOrQueuedExactlyOnce(refs, accepted);

    await outbox.retry(items[2].id);
    expect(await flushOutbox(send, { now: () => NOW + 10_000, schedule: false })).toBe(3);
    expect(outbox.all()).toHaveLength(0);
    expect(accepted.size).toBe(5);
    expect(attempts).toEqual([refs[0], refs[1], refs[2], refs[2], refs[3], refs[4]]);
    expectAcceptedOrQueuedExactlyOnce(refs, accepted);
  });

  it('replays an uncertain accepted request with the same key after the response is lost', async () => {
    const item = await outbox.add(input(1, 25));
    const ref = String(item.input.clientRef ?? item.id);
    const logicalServerRows = new Set<string>();
    let calls = 0;

    expect(await flushOutbox(async (entry) => {
      calls += 1;
      const key = String(entry.clientRef);
      logicalServerRows.add(key);
      throw new TypeError('Connection disappeared after the server committed.');
    }, { now: () => NOW, schedule: false })).toBe(0);

    expect(outbox.status(item.id).status).toBe('retry_wait');
    expect(outbox.all()).toHaveLength(1);
    await outbox.retry(item.id);

    expect(await flushOutbox(async (entry) => {
      calls += 1;
      const key = String(entry.clientRef);
      expect(key).toBe(ref);
      expect(logicalServerRows.has(key)).toBe(true);
      return { id: 'same-server-row', deduplicated: true };
    }, { now: () => NOW + 5_000, schedule: false })).toBe(1);

    expect(calls).toBe(2);
    expect(logicalServerRows.size).toBe(1);
    expect(outbox.all()).toHaveLength(0);
  });

  it('recovers an app-killed syncing item and retries it with the same idempotency key', async () => {
    const item = await outbox.add(input(7, 40));
    const ref = String(item.input.clientRef ?? item.id);
    await offlineSyncState.updateItem(item.id, {
      status: 'syncing',
      attempts: 1,
      lastAttemptAt: new Date(NOW - 1_000).toISOString(),
    });

    await offlineSyncState.recoverInterrupted(outbox.all(), new Date(NOW));
    expect(outbox.status(item.id)).toMatchObject({
      status: 'retry_wait',
      attempts: 1,
      lastError: { kind: 'interrupted' },
    });

    await outbox.retry(item.id);
    const seen: string[] = [];
    await flushOutbox(async (entry) => {
      seen.push(String(entry.clientRef));
      return { id: 'recovered' };
    }, { now: () => NOW + 1, schedule: false });
    expect(seen).toEqual([ref]);
    expect(outbox.all()).toHaveLength(0);
  });

  it('stops on session revocation, preserves later work, and resumes after the same user signs in again', async () => {
    const items = [await outbox.add(input(1)), await outbox.add(input(2)), await outbox.add(input(3))];
    const refs = items.map((item) => String(item.input.clientRef ?? item.id));
    const accepted = new Set<string>();
    let calls = 0;

    await expect(flushOutbox(async (entry) => {
      calls += 1;
      if (calls === 2) throw new NotSignedIn();
      accepted.add(String(entry.clientRef));
      return { ok: true };
    }, { now: () => NOW, schedule: false })).rejects.toMatchObject({ reason: 'auth' });

    expect(outbox.records().map(refOf)).toEqual(refs.slice(1));
    expect(outbox.status(items[1].id).status).toBe('blocked_auth');
    expectAcceptedOrQueuedExactlyOnce(refs, accepted);

    await lastUser.save(ACTIVE_USER);
    expect(outbox.status(items[1].id).status).toBe('pending');
    await flushOutbox(async (entry) => {
      accepted.add(String(entry.clientRef));
      return { ok: true };
    }, { now: () => NOW + 10_000, schedule: false });

    expect(outbox.all()).toHaveLength(0);
    expect(accepted.size).toBe(3);
    expectAcceptedOrQueuedExactlyOnce(refs, accepted);
  });

  it('quarantines pending work across logout/login and never exposes it to another user', async () => {
    const items = [await outbox.add(input(1)), await outbox.add(input(2))];
    const refs = items.map((item) => String(item.input.clientRef ?? item.id));

    await lastUser.clear();
    await lastUser.save({ id: 'other-user', email: 'other@example.com', role: 'entry' });
    expect(outbox.all()).toHaveLength(0);

    await lastUser.clear();
    await lastUser.save(ACTIVE_USER);
    expect(outbox.records().map(refOf)).toEqual(refs);
  });

  it('coalesces receipt reconnect storms and keeps interrupted uploads recoverable', async () => {
    const uploadIds: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes('/offline/entries/by-client-ref/')) return json(200, { id: 'server-entry' });
      if (url.includes('/delegation/attachments/entry/')) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        uploadIds.push(String(new Headers(init?.headers).get('x-offline-attachment-id')));
        return json(201, { ok: true });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    await attachmentQueue.queue(
      Array.from({ length: 20 }, (_, index) => image(`receipt-${index}.png`)),
      { clientRef: 'q_phase7_receipts' },
    );

    const results = await Promise.all(Array.from({ length: 10 }, () => attachmentQueue.flush({ force: true })));
    expect(results.every((count) => count === 20)).toBe(true);
    expect(uploadIds).toHaveLength(20);
    expect(new Set(uploadIds).size).toBe(20);
    expect(await attachmentQueue.summary()).toMatchObject({ uploaded: 20, waiting: 0, failed: 0 });

    const source = readFileSync(new URL('./offline-attachments.ts', import.meta.url), 'utf8');
    expect(source).toContain("record.status === 'uploading'");
    expect(source).toContain("status: 'waiting' as const");
    expect(source).toContain('Upload was interrupted and will resume.');
  });

  it('keeps airplane-mode boot and phone-restart recovery permanently wired', () => {
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
    const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
    const state = readFileSync(new URL('./offline-sync-state.ts', import.meta.url), 'utf8');

    expect(main).toContain("navigator.serviceWorker.register('/sw.js')");
    expect(main).toContain('await initializeOfflineStorage();');
    expect(sw).toContain("const SHELL = ['/', '/index.html', '/manifest.webmanifest'];");
    expect(sw).toContain("if (request.mode === 'navigate')");
    expect(sw).toContain("caches.match('/index.html')");
    expect(state).toContain('recoverInterrupted(queue: Queued[]');
    expect(state).toContain("current?.status === 'syncing'");
  });

  it('allows only one durable state per remaining queued item after chaos', async () => {
    const allowed = new Set(['pending', 'syncing', 'retry_wait', 'blocked_auth', 'conflict', 'rejected']);
    const items = [await outbox.add(input(1)), await outbox.add(input(2)), await outbox.add(input(3))];

    await flushOutbox(async () => {
      throw new ApiError('Temporary outage', 503, 'OUTAGE');
    }, { now: () => NOW, schedule: false });

    const rows = outbox.records();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    for (const item of items) expect(allowed.has(outbox.status(item.id).status)).toBe(true);
    expect(outbox.summary()).toMatchObject({ retrying: 1, blockedByOrder: 0 });
  });
});

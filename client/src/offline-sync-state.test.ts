import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NotSignedIn } from './api';
import {
  SyncBlockedError,
  flushOutbox,
  lastUser,
  outbox,
  resetOfflineStorageForTests,
} from './offline';
import { offlineSyncState } from './offline-sync-state';
import type { EntryInput } from '../../shared/types';

const NOW = Date.parse('2026-09-06T05:00:00.000Z');

function input(purpose = 'Offline expense'): EntryInput {
  return {
    occurredOn: '2026-09-06',
    kind: 'expense',
    amount: 25,
    purpose,
    raw: purpose,
    accountId: 'cash',
  };
}

describe('Advanced offline Phase 3 sync state machine', () => {
  beforeEach(async () => {
    await resetOfflineStorageForTests();
    await lastUser.save({ id: 'user-1', email: 'user' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetOfflineStorageForTests();
  });

  it('moves a queued entry through syncing and removes it only after acknowledgement', async () => {
    const item = await outbox.add(input());
    expect(outbox.status(item.id).status).toBe('pending');

    let duringSend = '';
    const sent = await flushOutbox(async (entry) => {
      duringSend = outbox.status(item.id).status;
      expect(entry.clientRef).toBe(item.id);
      expect(outbox.all()).toHaveLength(1);
      return { id: 'server-entry' };
    }, { now: () => NOW, schedule: false });

    expect(duringSend).toBe('syncing');
    expect(sent).toBe(1);
    expect(outbox.all()).toHaveLength(0);
    expect(outbox.summary().lastSuccessAt).toBe(new Date(NOW).toISOString());
  });

  it('retains transient failures in retry_wait and retries with the exact same idempotency key', async () => {
    const item = await outbox.add(input());
    const refs: Array<string | null | undefined> = [];

    const first = await flushOutbox(async (entry) => {
      refs.push(entry.clientRef);
      throw new ApiError('Service unavailable', 503, 'TEMPORARY');
    }, { now: () => NOW, schedule: false });

    expect(first).toBe(0);
    expect(outbox.all()).toHaveLength(1);
    expect(outbox.status(item.id)).toMatchObject({
      status: 'retry_wait',
      attempts: 1,
      lastError: { kind: 'server', status: 503, code: 'TEMPORARY' },
    });
    expect(Date.parse(outbox.status(item.id).nextAttemptAt!)).toBe(NOW + 2_000);

    await outbox.retry(item.id);
    const second = await flushOutbox(async (entry) => {
      refs.push(entry.clientRef);
      return { id: 'server-entry' };
    }, { now: () => NOW + 5_000, schedule: false });

    expect(second).toBe(1);
    expect(refs).toEqual([item.id, item.id]);
    expect(outbox.all()).toHaveLength(0);
  });

  it('treats network loss as retryable and never deletes the financial work', async () => {
    const item = await outbox.add(input());
    const sent = await flushOutbox(async () => {
      throw new TypeError('fetch failed');
    }, { now: () => NOW, schedule: false });

    expect(sent).toBe(0);
    expect(outbox.all().map((entry) => entry.id)).toEqual([item.id]);
    expect(outbox.status(item.id)).toMatchObject({
      status: 'retry_wait',
      lastError: { kind: 'network' },
    });
  });

  it('keeps a permanent refusal as rejected and prevents later entries from overtaking it', async () => {
    const first = await outbox.add(input('First'));
    const second = await outbox.add(input('Second'));
    expect(outbox.status(first.id).order).toBeLessThan(outbox.status(second.id).order);
    const send = vi.fn(async () => {
      throw new ApiError('Account no longer allowed', 403, 'ACCOUNT_REVOKED');
    });

    await expect(flushOutbox(send, { now: () => NOW, schedule: false }))
      .rejects.toMatchObject({ reason: 'rejected', itemId: first.id });

    expect(send).toHaveBeenCalledTimes(1);
    expect(outbox.all().map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(outbox.status(first.id)).toMatchObject({
      status: 'rejected',
      lastError: { status: 403, code: 'ACCOUNT_REVOKED' },
    });
    expect(outbox.summary()).toMatchObject({ rejected: 1, blockedByOrder: 1 });

    await expect(flushOutbox(send, { now: () => NOW + 10_000, schedule: false }))
      .rejects.toBeInstanceOf(SyncBlockedError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps expired-session work as blocked_auth until explicit retry after sign-in', async () => {
    const item = await outbox.add(input());
    const refs: Array<string | null | undefined> = [];

    await expect(flushOutbox(async (entry) => {
      refs.push(entry.clientRef);
      throw new NotSignedIn();
    }, { now: () => NOW, schedule: false })).rejects.toMatchObject({
      reason: 'auth', itemId: item.id,
    });

    expect(outbox.status(item.id)).toMatchObject({
      status: 'blocked_auth',
      lastError: { kind: 'auth', status: 401 },
    });
    expect(outbox.all()).toHaveLength(1);

    await outbox.retry(item.id);
    await flushOutbox(async (entry) => {
      refs.push(entry.clientRef);
      return { id: 'server-entry' };
    }, { now: () => NOW + 1_000, schedule: false });

    expect(refs).toEqual([item.id, item.id]);
    expect(outbox.all()).toHaveLength(0);
  });

  it('coalesces concurrent flush triggers so one queued entry is sent once', async () => {
    await outbox.add(input());
    const send = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true };
    });

    const [a, b] = await Promise.all([
      flushOutbox(send, { now: () => NOW, schedule: false }),
      flushOutbox(send, { now: () => NOW, schedule: false }),
    ]);

    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('recovers a crash-interrupted syncing state as an immediate safe retry', async () => {
    const item = await outbox.add(input());
    await offlineSyncState.updateItem(item.id, {
      status: 'syncing', attempts: 1, lastAttemptAt: new Date(NOW - 1000).toISOString(),
    });

    await offlineSyncState.recoverInterrupted(outbox.all(), new Date(NOW));
    expect(outbox.status(item.id)).toMatchObject({
      status: 'retry_wait',
      attempts: 1,
      nextAttemptAt: new Date(NOW).toISOString(),
      lastError: { kind: 'interrupted' },
    });
  });
});

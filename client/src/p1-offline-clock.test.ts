import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryInput } from '../../shared/types';
import {
  flushOutbox,
  initializeOfflineStorage,
  lastUser,
  outbox,
  resetOfflineStorageForTests,
} from './offline';

const USER = { id: 'p1-clock-user', email: 'p1-clock-user', role: 'entry' as const };

function input(index: number): EntryInput {
  return {
    occurredOn: '2026-09-06',
    kind: 'expense',
    amount: index,
    purpose: `Clock-safe ${index}`,
    raw: `Clock-safe ${index}`,
    accountId: 'clock-cash',
  };
}

describe('P1 bad-device-clock offline ordering certification', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await resetOfflineStorageForTests();
    await initializeOfflineStorage();
    await lastUser.save(USER);
  });

  afterEach(async () => {
    await resetOfflineStorageForTests();
    vi.useRealTimers();
  });

  it('keeps durable enqueue order even when the phone clock moves backwards between writes', async () => {
    vi.setSystemTime(new Date('2026-09-06T12:00:00.000Z'));
    const first = await outbox.add(input(1));
    vi.setSystemTime(new Date('2026-09-06T10:00:00.000Z'));
    const second = await outbox.add(input(2));
    vi.setSystemTime(new Date('2026-09-05T23:59:59.000Z'));
    const third = await outbox.add(input(3));

    // Timestamps are deliberately wrong/out of order. Phase 3's durable sync
    // sequence, not wall-clock time, must remain authoritative.
    expect(first.queuedAt > second.queuedAt).toBe(true);
    expect(second.queuedAt > third.queuedAt).toBe(true);
    expect(outbox.records().map((item) => item.id)).toEqual([first.id, second.id, third.id]);
    expect([
      outbox.status(first.id).order,
      outbox.status(second.id).order,
      outbox.status(third.id).order,
    ]).toEqual([1, 2, 3]);

    const sent: string[] = [];
    await flushOutbox(async (entry) => {
      sent.push(String(entry.clientRef));
      return { ok: true };
    }, { now: () => Date.now(), schedule: false });

    expect(sent).toEqual([first.id, second.id, third.id]);
    expect(outbox.all()).toHaveLength(0);
  });
});

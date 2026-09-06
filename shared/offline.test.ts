import { beforeEach, describe, expect, it, vi } from 'vitest';

/** localStorage remains only as the one-time source for the legacy migration. */
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});
vi.stubGlobal('navigator', { onLine: true });

const {
  flushOutbox,
  initializeOfflineStorage,
  lastUser,
  looksOffline,
  outbox,
  resetOfflineStorageForTests,
  snapshot,
} = await import('../client/src/offline.js');
import type { EntryInput } from './types.js';

const USER_ONE = { id: 'user-one', email: 'Owner One', role: 'owner' as const };
const USER_TWO = { id: 'user-two', email: 'Owner Two', role: 'owner' as const };

const entry = (amount: number, purpose: string): EntryInput => ({
  occurredOn: '2026-08-22', kind: 'expense', amount, purpose, raw: '', accountId: 'con_cash',
});

beforeEach(async () => {
  await resetOfflineStorageForTests();
  store.clear();
  (navigator as { onLine: boolean }).onLine = true;
  await initializeOfflineStorage();
  await lastUser.save(USER_ONE);
});

describe('with no signal', () => {
  it('keeps the last book so the app opens with figures', async () => {
    await snapshot.save({ totalCash: 1_000 });
    expect(snapshot.load<{ totalCash: number }>()?.totalCash).toBe(1_000);
  });

  it('holds entries in order and sends them oldest first', async () => {
    await outbox.add(entry(100, 'One'));
    await outbox.add(entry(200, 'Two'));
    const sent: string[] = [];

    const count = await flushOutbox(async (i) => { sent.push(i.purpose); });
    expect(sent).toEqual(['One', 'Two']);
    expect(count).toBe(2);
    expect(outbox.all()).toEqual([]);
  });

  it('stops at the first entry it still cannot send, and keeps the rest', async () => {
    await outbox.add(entry(100, 'One'));
    await outbox.add(entry(200, 'Two'));
    (navigator as { onLine: boolean }).onLine = false;

    const count = await flushOutbox(async () => { throw new TypeError('Failed to fetch'); });
    expect(count).toBe(0);
    expect(outbox.all()).toHaveLength(2);
  });

  it('preserves the existing terminal refusal behavior until the sync-state phase', async () => {
    await outbox.add(entry(100, 'One'));
    await expect(flushOutbox(async () => { throw new Error('A transfer needs both accounts.'); }))
      .rejects.toThrow('A transfer needs both accounts.');
    expect(outbox.all()).toHaveLength(0);
  });

  it('knows a lost network from a refusal', () => {
    expect(looksOffline(new TypeError('Failed to fetch'))).toBe(true);
    expect(looksOffline(new Error('That does not look right'))).toBe(false);
    (navigator as { onLine: boolean }).onLine = false;
    expect(looksOffline(new Error('anything'))).toBe(true);
  });
});

describe('the same entry can never land twice', () => {
  it('stamps every queued entry with its own reference', async () => {
    const queued = await outbox.add(entry(100, 'One'));
    expect(queued.input.clientRef).toBe(queued.id);
  });

  it('runs one flush even when the network returns twice at once', async () => {
    await outbox.add(entry(100, 'One'));
    await outbox.add(entry(200, 'Two'));
    const sent: string[] = [];
    const slow = async (i: EntryInput) => {
      await new Promise((r) => setTimeout(r, 10));
      sent.push(i.purpose);
    };

    const [a, b] = await Promise.all([flushOutbox(slow), flushOutbox(slow)]);
    expect(sent).toEqual(['One', 'Two']);
    expect(a).toBe(2);
    expect(b).toBe(2);
    expect(outbox.all()).toEqual([]);
  });
});

describe('Phase 1 user isolation', () => {
  it('keeps snapshots and queued financial work separate for each user', async () => {
    await snapshot.save({ owner: 'one', totalCash: 700 });
    await outbox.add(entry(100, 'One expense'));

    await lastUser.save(USER_TWO);
    expect(snapshot.load()).toBeNull();
    expect(outbox.all()).toEqual([]);

    await snapshot.save({ owner: 'two', totalCash: 900 });
    await outbox.add(entry(50, 'Two expense'));
    expect(outbox.all().map((item) => item.input.purpose)).toEqual(['Two expense']);

    await lastUser.save(USER_ONE);
    expect(snapshot.load<{ owner: string }>()?.owner).toBe('one');
    expect(outbox.all().map((item) => item.input.purpose)).toEqual(['One expense']);
  });

  it('quarantines unsent work on sign-out instead of exposing it to the next user', async () => {
    await snapshot.save({ private: 'book one' });
    await outbox.add(entry(125, 'Recover me'));
    await lastUser.clear();

    expect(lastUser.load()).toBeNull();
    expect(snapshot.load()).toBeNull();
    expect(outbox.all()).toEqual([]);

    await lastUser.save(USER_TWO);
    expect(outbox.all()).toEqual([]);

    await lastUser.save(USER_ONE);
    expect(snapshot.load()).toBeNull();
    expect(outbox.all().map((item) => item.input.purpose)).toEqual(['Recover me']);
  });

  it('can adopt the old localStorage snapshot and outbox into the legacy user scope', async () => {
    await resetOfflineStorageForTests();
    store.set('book.user', JSON.stringify(USER_ONE));
    store.set('book.snapshot', JSON.stringify({ migrated: true }));
    store.set('book.outbox', JSON.stringify([
      { id: 'q_legacy', input: { ...entry(80, 'Legacy'), clientRef: 'q_legacy' }, queuedAt: '2026-09-01T00:00:00.000Z' },
    ]));

    await initializeOfflineStorage();
    expect(lastUser.load<typeof USER_ONE>()?.id).toBe(USER_ONE.id);
    expect(snapshot.load<{ migrated: boolean }>()?.migrated).toBe(true);
    expect(outbox.all().map((item) => item.id)).toEqual(['q_legacy']);
  });
});

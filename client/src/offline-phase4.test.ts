import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type LoadedBook } from './api';
import {
  SyncBlockedError,
  flushOutbox,
  lastUser,
  outbox,
  resetOfflineStorageForTests,
  snapshot,
} from './offline';
import type { EntryInput } from '../../shared/types';
import type { OfflineEntryInput } from '../../shared/offline-conflict';

const local = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => local.get(key) ?? null,
  setItem: (key: string, value: string) => { local.set(key, value); },
  removeItem: (key: string) => { local.delete(key); },
});
vi.stubGlobal('navigator', { onLine: true });

function book(balance: number): LoadedBook {
  return {
    businesses: [{ id: 'biz', name: 'Business' }],
    accounts: [{ id: 'cash', name: 'Cash', businessId: 'biz', opening: 100 }],
    projects: [],
    receipts: [],
    people: [],
    loans: [],
    entries: [],
    reminders: [],
    balances: {
      totalCash: balance,
      accounts: { cash: balance },
      businesses: { biz: balance },
      people: {},
      loans: {},
      projects: {},
    },
  };
}

function expense(amount = 25): EntryInput {
  return {
    occurredOn: '2026-09-06',
    kind: 'expense',
    amount,
    purpose: 'Offline supplies',
    raw: 'Offline supplies',
    accountId: 'cash',
  };
}

beforeEach(async () => {
  await resetOfflineStorageForTests();
  local.clear();
  (navigator as { onLine: boolean }).onLine = true;
  await lastUser.save({ id: 'user-1', email: 'owner', role: 'owner' });
  await snapshot.save(book(100));
});

describe('Advanced offline Phase 4 conflicts', () => {
  it('captures the projected source balance each queued instruction relied on', async () => {
    const first = await outbox.add(expense(25));
    const firstInput = first.input as OfflineEntryInput;
    expect(firstInput.offlineContext?.sourceAccount).toMatchObject({ id: 'cash', businessId: 'biz', balance: 100 });

    const second = await outbox.add(expense(10));
    const secondInput = second.input as OfflineEntryInput;
    expect(secondInput.offlineContext?.sourceAccount?.balance).toBe(75);
    expect(snapshot.load<LoadedBook>()?.balances.accounts.cash).toBe(65);
  });

  it('keeps a server conflict durable and stops projecting it or later dependent work', async () => {
    const first = await outbox.add(expense(25));
    await outbox.add(expense(10));

    await expect(flushOutbox(async () => {
      throw new ApiError(
        'The source balance changed from $100.00 to $90.00 while this device was offline.',
        409,
        'OFFLINE_CONFLICT_STALE_BALANCE',
      );
    }, { schedule: false })).rejects.toMatchObject({ reason: 'conflict', itemId: first.id });

    expect(outbox.status(first.id).status).toBe('conflict');
    expect(outbox.status(first.id).conflict?.kind).toBe('stale_balance');
    expect(outbox.all()).toHaveLength(2);
    expect(outbox.summary()).toMatchObject({ conflicts: 1, blockedByOrder: 1 });
    expect(snapshot.load<LoadedBook>()?.balances.accounts.cash).toBe(100);
  });

  it('rebases a reviewed conflict on fresh server state and retries with the same intent', async () => {
    const item = await outbox.add(expense(25));
    await expect(flushOutbox(async () => {
      throw new ApiError('Balance changed.', 409, 'OFFLINE_CONFLICT_STALE_BALANCE');
    }, { schedule: false })).rejects.toBeInstanceOf(SyncBlockedError);

    const fresh = book(90);
    await snapshot.save(fresh);
    await outbox.rebase(item.id, fresh);
    expect(outbox.status(item.id).status).toBe('pending');
    expect(outbox.status(item.id).conflict).toBeNull();
    const revised = outbox.records()[0].input as OfflineEntryInput;
    expect(revised.offlineContext?.sourceAccount?.balance).toBe(90);
    expect(revised.amount).toBe(25);

    const seen: EntryInput[] = [];
    expect(await flushOutbox(async (input) => { seen.push(input); }, { schedule: false })).toBe(1);
    expect(seen).toHaveLength(1);
    expect(outbox.all()).toHaveLength(0);
  });

  it('can edit a conflicted amount before retrying without mutating the original queue identity', async () => {
    const item = await outbox.add(expense(80));
    await expect(flushOutbox(async () => {
      throw new ApiError('Only $50.00 remains.', 409, 'OFFLINE_CONFLICT_INSUFFICIENT_FUNDS');
    }, { schedule: false })).rejects.toBeInstanceOf(SyncBlockedError);

    await outbox.rebase(item.id, book(50), { amount: 40, purpose: 'Reduced purchase' });
    const revised = outbox.records()[0];
    expect(revised.id).toBe(item.id);
    expect(revised.input.amount).toBe(40);
    expect(revised.input.purpose).toBe('Reduced purchase');
    expect((revised.input as OfflineEntryInput).offlineContext?.sourceAccount?.balance).toBe(50);
  });
});

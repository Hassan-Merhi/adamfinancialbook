import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedBook } from './api';
import {
  flushOutbox,
  lastUser,
  outbox,
  resetOfflineStorageForTests,
  snapshot,
} from './offline';
import type { Entry } from '../../shared/types';

const local = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => local.get(key) ?? null,
  setItem: (key: string, value: string) => { local.set(key, value); },
  removeItem: (key: string) => { local.delete(key); },
});
vi.stubGlobal('navigator', { onLine: true });

const baseEntry: Entry = {
  id: 'entry-1',
  occurredOn: '2026-09-06',
  kind: 'expense',
  amount: 20,
  purpose: 'Fuel',
  raw: '$20 fuel from cash',
  accountId: 'cash',
  toAccountId: null,
  projectId: null,
  personId: null,
  forBusiness: null,
  historical: false,
  linkReceiptId: null,
  clientRef: 'online-entry-1',
  effects: [{ type: 'account', targetId: 'cash', delta: -20 }],
  correctedFrom: null,
  correctedAt: null,
  correctedBy: null,
  correctionReason: '',
  voided: false,
  voidReason: null,
  voidedAt: null,
  voidedBy: null,
  transactionId: 'txn-1',
  createdAt: '2026-09-06T08:00:00.000Z',
};

function book(): LoadedBook {
  return {
    businesses: [{ id: 'biz', name: 'Business' }],
    accounts: [{ id: 'cash', name: 'Cash', businessId: 'biz', opening: 100 }],
    projects: [],
    receipts: [],
    people: [],
    loans: [],
    entries: [{ ...baseEntry, effects: baseEntry.effects.map((effect) => ({ ...effect })) }],
    reminders: [],
    balances: {
      totalCash: 80,
      accounts: { cash: 80 },
      businesses: { biz: 80 },
      people: {},
      loans: {},
      projects: {},
    },
  };
}

beforeEach(async () => {
  await resetOfflineStorageForTests();
  local.clear();
  (navigator as { onLine: boolean }).onLine = true;
  await lastUser.save({ id: 'owner-1', email: 'owner', role: 'owner' });
  await snapshot.save(book());
  vi.restoreAllMocks();
});

describe('Offline Correct + Void Phase 1', () => {
  it('projects a queued correction without mutating the confirmed snapshot', async () => {
    const confirmed = snapshot.loadConfirmed<LoadedBook>()!;
    await outbox.correct(confirmed.entries[0], 30);

    const projected = snapshot.load<LoadedBook>()!;
    expect(projected.balances.totalCash).toBe(70);
    expect(projected.balances.accounts.cash).toBe(70);
    expect(projected.balances.businesses.biz).toBe(70);
    expect(projected.entries[0]).toMatchObject({
      id: 'entry-1',
      amount: 30,
      correctedFrom: 20,
      offlinePendingRevision: 'correction',
    });

    const stillConfirmed = snapshot.loadConfirmed<LoadedBook>()!;
    expect(stillConfirmed.balances.accounts.cash).toBe(80);
    expect(stillConfirmed.entries[0].amount).toBe(20);
    expect(stillConfirmed.entries[0].correctedFrom).toBeNull();
  });

  it('projects a queued void as an immediate accounting reversal', async () => {
    const confirmed = snapshot.loadConfirmed<LoadedBook>()!;
    await outbox.void(confirmed.entries[0], 'Duplicate receipt');

    const projected = snapshot.load<LoadedBook>()!;
    expect(projected.balances.totalCash).toBe(100);
    expect(projected.balances.accounts.cash).toBe(100);
    expect(projected.entries[0]).toMatchObject({
      id: 'entry-1',
      voided: true,
      voidReason: 'Duplicate receipt',
      offlinePendingRevision: 'void',
    });
    expect(projected.entries[0].effects).toEqual([]);

    expect(snapshot.loadConfirmed<LoadedBook>()!.balances.accounts.cash).toBe(80);
  });

  it('locks an entry once one offline revision is waiting', async () => {
    const entry = snapshot.loadConfirmed<LoadedBook>()!.entries[0];
    await outbox.correct(entry, 30);
    await expect(outbox.correct(entry, 35)).rejects.toThrow(/already has an offline correction or void/i);
    await expect(outbox.void(entry, 'Wrong')).rejects.toThrow(/already has an offline correction or void/i);
    expect(outbox.all()).toHaveLength(1);
  });

  it('captures later ordinary entries from the revised projected balance', async () => {
    const entry = snapshot.loadConfirmed<LoadedBook>()!.entries[0];
    await outbox.correct(entry, 30);
    const later = await outbox.add({
      occurredOn: '2026-09-06',
      kind: 'expense',
      amount: 10,
      purpose: 'Lunch',
      raw: '$10 lunch from cash',
      accountId: 'cash',
    });

    expect((later.input as any).offlineContext.sourceAccount.balance).toBe(70);
    expect(snapshot.load<LoadedBook>()!.balances.accounts.cash).toBe(60);
  });

  it('routes a queued correction to its revision endpoint instead of the ordinary entry sender', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const ordinarySender = vi.fn(async () => ({ ok: true }));

    const entry = snapshot.loadConfirmed<LoadedBook>()!.entries[0];
    await outbox.correct(entry, 30);
    expect(await flushOutbox(ordinarySender, { schedule: false })).toBe(1);

    expect(ordinarySender).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/entries/entry-1');
    expect((options as RequestInit).method).toBe('PATCH');
    const body = JSON.parse(String((options as RequestInit).body));
    expect(body.amount).toBe(30);
    expect(body.clientRef).toMatch(/^q_/);
    expect(body.offlineContext.entry.amount).toBe(20);
    expect(outbox.all()).toHaveLength(0);
  });
});

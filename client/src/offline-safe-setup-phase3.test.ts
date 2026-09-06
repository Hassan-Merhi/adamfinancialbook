import { afterEach, describe, expect, it } from 'vitest';
import type { LoadedBook } from './api';
import { initializeOfflineStorage, lastUser, outbox, resetOfflineStorageForTests, snapshot } from './offline';
import { orderQueuedByDependencies } from './offline-dependencies';
import { offlineSetupEntityId, type OfflineSetupInput } from '../../shared/offline-setup';
import type { Queued } from './offline-db';

function baseBook(): LoadedBook {
  return {
    businesses: [{ id: 'biz_confirmed', name: 'Confirmed' }],
    accounts: [{ id: 'acc_confirmed', name: 'Cash', businessId: 'biz_confirmed', opening: 100 }],
    projects: [], receipts: [], people: [], loans: [], entries: [], reminders: [],
    balances: { totalCash: 100, accounts: { acc_confirmed: 100 }, businesses: { biz_confirmed: 100 }, people: {}, loans: {}, projects: {} },
  };
}

async function ready(): Promise<void> {
  await resetOfflineStorageForTests();
  await initializeOfflineStorage();
  await lastUser.save({ id: 'owner-phase3', role: 'owner' });
  await snapshot.save(baseBook());
}

afterEach(async () => { await resetOfflineStorageForTests(); });

describe('Offline safe setup Phase 3 dependencies', () => {
  it('queues a full parent-child chain using projected final ids', async () => {
    await ready();
    const business = await outbox.setup({ setupType: 'business', name: 'Offline Business' });
    const businessInput = business.input as unknown as OfflineSetupInput;
    const businessId = offlineSetupEntityId(businessInput);

    const account = await outbox.setup({ setupType: 'account', name: 'Offline Cash', businessId, opening: 25 });
    const accountInput = account.input as unknown as OfflineSetupInput;
    const accountId = offlineSetupEntityId(accountInput);
    const project = await outbox.setup({ setupType: 'project', name: 'Offline Job', businessId, opening: 300, scope: '' });
    const person = await outbox.setup({ setupType: 'person', name: 'Offline Supplier', businessId, kind: 'payable', opening: 75, salary: 0, role: 'Supplier' });
    const reminder = await outbox.setup({ setupType: 'reminder', what: 'Offline reminder', amount: 9, accountId, note: '' });

    expect((account.input as any).offlineDependsOn).toEqual([business.id]);
    expect((project.input as any).offlineDependsOn).toEqual([business.id]);
    expect((person.input as any).offlineDependsOn).toEqual([business.id]);
    expect((reminder.input as any).offlineDependsOn).toEqual([account.id]);

    const projected = snapshot.load<LoadedBook>()!;
    expect(projected.businesses.some((item) => item.id === businessId)).toBe(true);
    expect(projected.accounts.find((item) => item.id === accountId)?.businessId).toBe(businessId);
    expect(projected.balances.businesses[businessId]).toBe(25);
    expect(projected.balances.accounts[accountId]).toBe(25);
    expect(projected.balances.totalCash).toBe(125);
  });

  it('topologically restores parent-before-child order after persistence ordering changes', () => {
    const parent: Queued = {
      id: 'q_parent', queuedAt: '2026-09-06T11:20:00.000Z',
      input: { offlineOperation: 'setup_create', setupType: 'business', name: 'Parent', clientRef: 'q_parent', offlineDependsOn: [] } as any,
    };
    const child: Queued = {
      id: 'q_child', queuedAt: '2026-09-06T11:20:00.000Z',
      input: { offlineOperation: 'setup_create', setupType: 'account', name: 'Child', businessId: offlineSetupEntityId(parent.input as any), opening: 0, clientRef: 'q_child', offlineDependsOn: ['q_parent'] } as any,
    };
    expect(orderQueuedByDependencies([child, parent]).map((item) => item.id)).toEqual(['q_parent', 'q_child']);
  });

  it('does not allow a parent to be discarded while children depend on it', async () => {
    await ready();
    const business = await outbox.setup({ setupType: 'business', name: 'Offline Business' });
    const businessId = offlineSetupEntityId(business.input as any);
    await outbox.setup({ setupType: 'project', name: 'Child Project', businessId, opening: 0, scope: '' });
    await expect(outbox.drop(business.id)).rejects.toThrow(/dependent change/);
  });

  it('still refuses references that are neither confirmed nor durably queued', async () => {
    await ready();
    await expect(outbox.setup({ setupType: 'project', name: 'Orphan', businessId: 'biz_missing', opening: 0, scope: '' }))
      .rejects.toThrow(/not available offline/);
  });
});

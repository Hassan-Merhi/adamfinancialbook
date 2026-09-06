import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LoadedBook } from './api';
import { projectOfflineBook } from './offline-projection';
import { offlineSetupEntityId, type OfflineSetupInput } from '../../shared/offline-setup';
import type { Queued } from './offline-db';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function baseBook(): LoadedBook {
  return {
    businesses: [{ id: 'biz_confirmed', name: 'Confirmed' }],
    accounts: [{ id: 'acc_confirmed', name: 'Cash', businessId: 'biz_confirmed', opening: 100 }],
    projects: [], receipts: [], people: [], loans: [], entries: [], reminders: [],
    balances: { totalCash: 100, accounts: { acc_confirmed: 100 }, businesses: { biz_confirmed: 100 }, people: {}, loans: {}, projects: {} },
  };
}

function queued(id: string, input: OfflineSetupInput): Queued {
  return { id, input: input as any, queuedAt: '2026-09-06T10:00:00.000Z' };
}

describe('Offline safe setup Phase 2', () => {
  it('projects safe setup records with their final deterministic server ids', () => {
    const account: OfflineSetupInput = { offlineOperation: 'setup_create', setupType: 'account', name: 'Offline Cash', businessId: 'biz_confirmed', opening: 25, clientRef: 'q_account_1' };
    const project: OfflineSetupInput = { offlineOperation: 'setup_create', setupType: 'project', name: 'Offline Job', businessId: 'biz_confirmed', opening: 300, scope: '', clientRef: 'q_project_1' };
    const person: OfflineSetupInput = { offlineOperation: 'setup_create', setupType: 'person', name: 'Offline Supplier', businessId: 'biz_confirmed', kind: 'payable', opening: 75, salary: 0, role: 'Supplier', clientRef: 'q_person_1' };
    const reminder: OfflineSetupInput = { offlineOperation: 'setup_create', setupType: 'reminder', what: 'Offline reminder', amount: 9, accountId: 'acc_confirmed', note: '', clientRef: 'q_reminder_1' };
    const projected = projectOfflineBook(baseBook(), [queued('q_account_1', account), queued('q_project_1', project), queued('q_person_1', person), queued('q_reminder_1', reminder)]);
    const accountId = offlineSetupEntityId(account);
    const projectId = offlineSetupEntityId(project);
    const personId = offlineSetupEntityId(person);
    const reminderId = offlineSetupEntityId(reminder);
    expect(projected.accounts.find((item) => item.id === accountId)?.opening).toBe(25);
    expect(projected.balances.accounts[accountId]).toBe(25);
    expect(projected.balances.totalCash).toBe(125);
    expect(projected.balances.businesses.biz_confirmed).toBe(125);
    expect(projected.projects.find((item) => item.id === projectId)?.name).toBe('Offline Job');
    expect(projected.balances.projects[projectId]).toBe(300);
    expect(projected.people.find((item) => item.id === personId)?.name).toBe('Offline Supplier');
    expect(projected.balances.people[personId]).toBe(-75);
    expect(projected.reminders.find((item) => item.id === reminderId)?.what).toBe('Offline reminder');
  });

  it('keeps destructive and dependency-sensitive setup operations online-only', () => {
    const setup = read('client/src/views/Setup.tsx');
    expect(setup).toContain("outbox.setup({ setupType: 'business'");
    expect(setup).toContain("outbox.setup({ setupType: 'account'");
    expect(setup).toContain("outbox.setup({ setupType: 'project'");
    expect(setup).toContain("outbox.setup({ setupType: 'person'");
    expect(setup).toContain("outbox.setup({ setupType: 'reminder'");
    expect(setup).toContain('api.setLoan(');
    expect(setup).toContain('api.clearReminder(');
    expect(setup).toContain('confirmedBusinesses');
    expect(setup).toContain('confirmedAccounts');
  });

  it('routes offline setup through the protected idempotent server boundary before legacy setup routes', () => {
    const start = read('server/start.ts');
    const server = read('server/offline-setup.ts');
    expect(start).toContain('offlineSetupRouter');
    expect(start.indexOf('protectedSecurityRouter.use(offlineSetupRouter)')).toBeLessThan(start.indexOf('protectedSecurityRouter.use(offlineSyncRouter)'));
    expect(server).toContain('pg_advisory_xact_lock');
    expect(server).toContain('OFFLINE_CONFLICT_IDEMPOTENCY_KEY_REUSED');
    expect(server).toContain('OFFLINE_CONFLICT_TARGET_MISSING');
    expect(server).toContain('recordRequired');
  });
});

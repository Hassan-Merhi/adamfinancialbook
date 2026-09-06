import fs from 'node:fs';

const statePath = 'client/src/offline-sync-state.ts';
let state = fs.readFileSync(statePath, 'utf8');

const importNeedle = "import type { OfflineConflictInfo, OfflineEntryInput } from '../../shared/offline-conflict';\n";
const importReplacement = `${importNeedle}import { orderQueuedByDependencies } from './offline-dependencies';\n`;
if (!state.includes("import { orderQueuedByDependencies } from './offline-dependencies';")) {
  if (!state.includes(importNeedle)) throw new Error('Phase 4 import insertion point not found.');
  state = state.replace(importNeedle, importReplacement);
}

const prefixNeedle = `  projectablePrefix(queue: Queued[]): Queued[] {\n    const visible: Queued[] = [];\n    for (const item of this.effective(queue)) {\n`;
const prefixReplacement = `  projectablePrefix(queue: Queued[]): Queued[] {\n    const visible: Queued[] = [];\n    for (const item of orderQueuedByDependencies(this.effective(queue))) {\n`;
if (state.includes(prefixNeedle)) {
  state = state.replace(prefixNeedle, prefixReplacement);
} else if (!state.includes(prefixReplacement)) {
  throw new Error('Phase 4 projectable-prefix insertion point not found.');
}

const summaryNeedle = `    let orderBlocked = false;\n\n    for (const item of this.ordered(queue)) {\n      const state = this.stateFor(item.id);\n`;
const summaryReplacement = `    let orderBlocked = false;\n\n    for (const item of orderQueuedByDependencies(this.effective(queue))) {\n      const state = this.stateFor(item.id);\n`;
if (state.includes(summaryNeedle)) {
  state = state.replace(summaryNeedle, summaryReplacement);
} else if (!state.includes(summaryReplacement)) {
  throw new Error('Phase 4 summary insertion point not found.');
}

fs.writeFileSync(statePath, state);

const testPath = 'client/src/offline-safe-setup-phase4.test.ts';
const test = `import { afterEach, describe, expect, it } from 'vitest';
import type { LoadedBook } from './api';
import type { Queued } from './offline-db';
import { offlineSyncState } from './offline-sync-state';
import { projectOfflineBook } from './offline-projection';
import { offlineSetupEntityId } from '../../shared/offline-setup';

function baseBook(): LoadedBook {
  return {
    businesses: [{ id: 'biz_confirmed', name: 'Confirmed' }],
    accounts: [{ id: 'acc_confirmed', name: 'Cash', businessId: 'biz_confirmed', opening: 100 }],
    projects: [], receipts: [], people: [], loans: [], entries: [], reminders: [],
    balances: {
      totalCash: 100,
      accounts: { acc_confirmed: 100 },
      businesses: { biz_confirmed: 100 },
      people: {}, loans: {}, projects: {},
    },
  };
}

function setupChain(): { parent: Queued; child: Queued; grandchild: Queued; parentId: string; childId: string } {
  const parent: Queued = {
    id: 'q_parent',
    queuedAt: '2026-09-06T12:00:00.000Z',
    input: {
      offlineOperation: 'setup_create', setupType: 'business', name: 'Offline Parent',
      clientRef: 'q_parent', offlineDependsOn: [],
    } as any,
  };
  const parentId = offlineSetupEntityId(parent.input as any);
  const child: Queued = {
    id: 'q_child',
    queuedAt: '2026-09-06T12:00:00.000Z',
    input: {
      offlineOperation: 'setup_create', setupType: 'account', name: 'Offline Child',
      businessId: parentId, opening: 25, clientRef: 'q_child', offlineDependsOn: ['q_parent'],
    } as any,
  };
  const childId = offlineSetupEntityId(child.input as any);
  const grandchild: Queued = {
    id: 'q_grandchild',
    queuedAt: '2026-09-06T12:00:00.000Z',
    input: {
      offlineOperation: 'setup_create', setupType: 'reminder', what: 'Offline reminder', amount: 5,
      accountId: childId, note: '', clientRef: 'q_grandchild', offlineDependsOn: ['q_child'],
    } as any,
  };
  return { parent, child, grandchild, parentId, childId };
}

async function registerChildBeforeParent(queue: Queued[]): Promise<void> {
  await offlineSyncState.activate('phase4-dependency-test');
  for (const item of queue) await offlineSyncState.registerQueued(item.id);
}

function conflictState() {
  return {
    status: 'conflict' as const,
    conflict: {
      kind: 'target_changed' as const,
      message: 'Parent changed on the server.',
      targetId: 'q_parent',
      expected: null,
      current: null,
      detectedAt: '2026-09-06T12:01:00.000Z',
    },
  };
}

afterEach(async () => {
  await offlineSyncState.resetForTests();
});

describe('Offline safe setup Phase 4 conflict safety', () => {
  it('does not project a child when its parent conflicts even if durable order has the child first', async () => {
    const { parent, child, parentId, childId } = setupChain();
    await registerChildBeforeParent([child, parent]);
    await offlineSyncState.updateItem(parent.id, conflictState());

    expect(offlineSyncState.projectablePrefix([child, parent])).toEqual([]);
    const projected = projectOfflineBook(baseBook(), [child, parent]);
    expect(projected.businesses.some((item) => item.id === parentId)).toBe(false);
    expect(projected.accounts.some((item) => item.id === childId)).toBe(false);
    expect(projected.balances.totalCash).toBe(100);
  });

  it('does not project descendants of a rejected parent', async () => {
    const { parent, child, grandchild, parentId, childId } = setupChain();
    await registerChildBeforeParent([grandchild, child, parent]);
    await offlineSyncState.updateItem(parent.id, {
      status: 'rejected',
      lastError: {
        kind: 'server', message: 'Parent was refused.', status: 422,
        code: 'SETUP_REJECTED', at: '2026-09-06T12:01:00.000Z',
      },
    });

    expect(offlineSyncState.projectablePrefix([grandchild, child, parent])).toEqual([]);
    const projected = projectOfflineBook(baseBook(), [grandchild, child, parent]);
    expect(projected.businesses.some((item) => item.id === parentId)).toBe(false);
    expect(projected.accounts.some((item) => item.id === childId)).toBe(false);
    expect(projected.reminders.some((item) => item.id === offlineSetupEntityId(grandchild.input as any))).toBe(false);
  });

  it('reports downstream rows as blocked using the same dependency order as replay', async () => {
    const { parent, child, grandchild } = setupChain();
    await registerChildBeforeParent([grandchild, child, parent]);
    await offlineSyncState.updateItem(parent.id, conflictState());

    const summary = offlineSyncState.summary([grandchild, child, parent]);
    expect(summary.conflicts).toBe(1);
    expect(summary.blockedByOrder).toBe(2);
    expect(summary.pending).toBe(2);
  });

  it('keeps the complete chain projectable when no parent is blocked', async () => {
    const { parent, child, grandchild } = setupChain();
    await registerChildBeforeParent([grandchild, child, parent]);

    expect(offlineSyncState.projectablePrefix([grandchild, child, parent]).map((item) => item.id))
      .toEqual(['q_parent', 'q_child', 'q_grandchild']);
  });
});
`;
fs.writeFileSync(testPath, test);

const docPath = 'docs/OFFLINE_SAFE_SETUP_PHASE4_CONFLICT_SAFETY.md';
const doc = `# Offline Safe Setup Phase 4 — Conflict & Financial Safety\n\nPhase 4 makes dependency ordering a single safety contract across replay, projected UI state, and Sync Center status.\n\n- A queued parent setup item is always evaluated before its dependent children, even after restart, timestamp ties, or legacy durable-order recovery.\n- If a parent reaches conflict or rejection, that parent and every downstream child stop contributing to the projected offline book.\n- Sync status counts descendants behind the blocking parent in the same order used by actual replay.\n- Children can never overtake a conflicted/rejected parent, and a parent cannot be discarded while queued children still depend on it.\n- The server remains final authority for validation, financial effects, authorization, idempotency, and audit records.\n- No database migration or accounting-rule change is introduced by this hardening pass.\n`;
fs.writeFileSync(docPath, doc);

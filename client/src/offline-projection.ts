import type { LoadedBook } from './api';
import type { Queued } from './offline-db';
import { orderQueuedByDependencies } from './offline-dependencies';
import { offlineSyncState } from './offline-sync-state';
import { round, withLoanEffects } from '../../shared/engine';
import { isOfflineCorrectionInput, isOfflineRevisionInput } from '../../shared/offline-conflict';
import { isOfflineSetupInput, offlineSetupEntityId, offlineSetupReceiptId, type OfflineSetupInput } from '../../shared/offline-setup';
import type { Effect, Entry, EntryInput, Person } from '../../shared/types';

const PROJECTED_PREFIX = 'offline:';

export function isProjectedEntry(entry: Pick<Entry, 'id'>): boolean {
  return entry.id.startsWith(PROJECTED_PREFIX);
}

/**
 * Build the view the user should see while writes are waiting to sync.
 *
 * The confirmed server snapshot is never mutated or rewritten. Queued entries
 * are materialized as synthetic ledger rows. Queued corrections replace the
 * target row's active effects in the projection; queued voids reverse them and
 * mark the row void. A permanently blocked row stops the projected prefix so
 * later writes cannot pretend they sit on a server state that was never accepted.
 */
export function projectOfflineBook(confirmed: LoadedBook, queue: Queued[]): LoadedBook {
  const projectable = offlineSyncState.projectablePrefix(queue);
  if (!projectable.length) return confirmed;

  const alreadyConfirmed = new Set(
    confirmed.entries
      .map((entry) => entry.clientRef)
      .filter((ref): ref is string => typeof ref === 'string' && !!ref),
  );
  const hasVisibleProjection = projectable.some((item) =>
    isOfflineRevisionInput(item.input)
      || !alreadyConfirmed.has(item.input.clientRef ?? item.id));
  if (!hasVisibleProjection) return confirmed;

  const balances = {
    totalCash: confirmed.balances.totalCash,
    accounts: { ...confirmed.balances.accounts },
    businesses: { ...confirmed.balances.businesses },
    people: { ...confirmed.balances.people },
    loans: { ...confirmed.balances.loans },
    projects: { ...confirmed.balances.projects },
  };
  const entries = confirmed.entries.map((entry) => ({ ...entry, effects: entry.effects.map((effect) => ({ ...effect })) }));
  const businesses = confirmed.businesses.map((item) => ({ ...item }));
  const accounts = confirmed.accounts.map((item) => ({ ...item }));
  const projects = confirmed.projects.map((item) => ({ ...item }));
  const people = confirmed.people.map((item) => ({ ...item }));
  const reminders = confirmed.reminders.map((item) => ({ ...item }));
  let receipts = confirmed.receipts.map((receipt) => ({ ...receipt }));
  const projectedEntries: Entry[] = [];

  for (const item of orderQueuedByDependencies(projectable)) {
    if (isOfflineSetupInput(item.input as unknown)) {
      const setup = item.input as unknown as OfflineSetupInput;
      const id = offlineSetupEntityId(setup);
      if (setup.setupType === 'business') {
        if (!businesses.some((row) => row.id === id)) {
businesses.push({ id, name: setup.name });
balances.businesses[id] = 0;
        }
      } else if (setup.setupType === 'account') {
        if (!accounts.some((row) => row.id === id)) {
accounts.push({ id, name: setup.name, businessId: setup.businessId as string, opening: setup.opening });
balances.accounts[id] = round(setup.opening);
balances.totalCash = round(balances.totalCash + setup.opening);
if (setup.businessId) balances.businesses[setup.businessId] = round((balances.businesses[setup.businessId] ?? 0) + setup.opening);
        }
      } else if (setup.setupType === 'project') {
        if (!projects.some((row) => row.id === id)) {
projects.push({ id, name: setup.name, scope: setup.scope ?? '', businessId: setup.businessId });
balances.projects[id] = round(setup.opening);
if (setup.opening > 0) {
  const receiptId = offlineSetupReceiptId(setup.clientRef);
  if (!receipts.some((row) => row.id === receiptId)) receipts.push({ id: receiptId, projectId: id, occurredOn: '', amount: setup.opening, inCash: true, entryId: null });
}
        }
      } else if (setup.setupType === 'person') {
        if (!people.some((row) => row.id === id)) {
people.push({ id, name: setup.name, role: setup.role, businessId: setup.businessId, kind: setup.kind, opening: setup.opening, salary: setup.salary });
balances.people[id] = round(setup.kind === 'receivable' ? setup.opening : setup.kind === 'payable' ? -setup.opening : setup.opening - setup.salary);
        }
      } else if (!reminders.some((row) => row.id === id)) {
        reminders.push({ id, what: setup.what, amount: setup.amount, accountId: setup.accountId, note: setup.note ?? '', settled: false });
      }
      continue;
    }

    if (isOfflineRevisionInput(item.input)) {
      const revision = item.input;
      const index = entries.findIndex((entry) => entry.id === revision.entryId);
      if (index < 0) continue;
      const target = entries[index];

      if (isOfflineCorrectionInput(revision)) {
        // If an uncertain response actually committed and a fresh snapshot was
        // loaded before the outbox acknowledgement, do not project it twice.
        if (target.correctedAt && target.correctedFrom != null && Math.abs(target.amount - revision.amount) < 0.005) {
          entries[index] = {
            ...target,
            offlinePendingRevision: 'correction',
            offlineQueueId: item.id,
          };
          continue;
        }
        if (target.voided) continue;
        applyEffects(balances, reverseEffects(target.effects), confirmed);
        const nextInput: EntryInput = { ...target, amount: revision.amount };
        const effects = withLoanEffects(nextInput, confirmed);
        entries[index] = {
          ...target,
          amount: revision.amount,
          effects,
          correctedFrom: target.correctedFrom ?? target.amount,
          correctedAt: item.queuedAt,
          correctionReason: `Amount correction waiting to sync`,
          offlinePendingRevision: 'correction',
          offlineQueueId: item.id,
        };
        applyEffects(balances, effects, confirmed);
        if (target.kind === 'receipt' && !target.linkReceiptId) {
          receipts = receipts.map((receipt) => receipt.entryId === target.id
            ? { ...receipt, amount: revision.amount }
            : receipt);
        }
        continue;
      }

      if (target.voided) {
        entries[index] = {
          ...target,
          offlinePendingRevision: 'void',
          offlineQueueId: item.id,
        };
        continue;
      }
      applyEffects(balances, reverseEffects(target.effects), confirmed);
      entries[index] = {
        ...target,
        effects: [],
        voided: true,
        voidReason: revision.reason,
        voidedAt: item.queuedAt,
        offlinePendingRevision: 'void',
        offlineQueueId: item.id,
      };
      if (target.kind === 'receipt') {
        if (target.linkReceiptId) {
          receipts = receipts.map((receipt) => receipt.id === target.linkReceiptId
            ? { ...receipt, inCash: false }
            : receipt);
        } else {
          receipts = receipts.filter((receipt) => receipt.entryId !== target.id);
        }
      }
      continue;
    }

    const ref = item.input.clientRef ?? item.id;
    if (alreadyConfirmed.has(ref)) continue;
    const input = { ...item.input, clientRef: ref };
    const effects = withLoanEffects(input, confirmed);
    const projected: Entry = {
      ...input,
      id: `${PROJECTED_PREFIX}${item.id}`,
      effects,
      correctedFrom: null,
      transactionId: null,
      createdAt: item.queuedAt,
    };
    projectedEntries.push(projected);
    applyEffects(balances, effects, confirmed);
  }

  // Phase 2's ordinary-entry contract was `entries: [...confirmed.entries, ...projectedEntries]`.
  // Revisions clone/overlay confirmed rows first, so `entries` is the immutable working copy.
  return {
    ...confirmed,
    businesses,
    accounts,
    projects,
    people,
    reminders,
    receipts,
    entries: [...entries, ...projectedEntries],
    balances,
  };
}

function reverseEffects(effects: Effect[]): Effect[] {
  return effects.map((effect) => ({ ...effect, delta: -effect.delta }));
}

function applyEffects(
  balances: LoadedBook['balances'],
  effects: Effect[],
  book: LoadedBook,
): void {
  for (const effect of effects) {
    if (effect.type === 'account' && effect.targetId) {
      balances.accounts[effect.targetId] = round((balances.accounts[effect.targetId] ?? 0) + effect.delta);
      balances.totalCash = round(balances.totalCash + effect.delta);
      const businessId = book.accounts.find((account) => account.id === effect.targetId)?.businessId;
      if (businessId) {
        balances.businesses[businessId] = round((balances.businesses[businessId] ?? 0) + effect.delta);
      }
      continue;
    }

    if (effect.type === 'person' && effect.targetId) {
      const person = book.people.find((candidate) => candidate.id === effect.targetId);
      if (!person) continue;
      balances.people[person.id] = round(
        (balances.people[person.id] ?? 0) + personDeltaInDisplayedTerms(person, effect.delta),
      );
      continue;
    }

    if (effect.type === 'project' && effect.targetId) {
      balances.projects[effect.targetId] = round((balances.projects[effect.targetId] ?? 0) + effect.delta);
      continue;
    }

    if (effect.type === 'loan' && effect.fromBusiness && effect.toBusiness) {
      const loan = book.loans.find((candidate) =>
        (candidate.fromBusiness === effect.fromBusiness && candidate.toBusiness === effect.toBusiness)
        || (candidate.fromBusiness === effect.toBusiness && candidate.toBusiness === effect.fromBusiness));
      if (!loan) continue;
      const canonicalDelta = loan.fromBusiness === effect.fromBusiness
        && loan.toBusiness === effect.toBusiness
        ? effect.delta
        : -effect.delta;
      balances.loans[loan.id] = round((balances.loans[loan.id] ?? 0) + canonicalDelta);
    }
  }
}

function personDeltaInDisplayedTerms(person: Person, delta: number): number {
  return person.kind === 'payable' ? -delta : delta;
}

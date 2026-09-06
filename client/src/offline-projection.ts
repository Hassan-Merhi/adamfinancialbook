import type { LoadedBook } from './api';
import type { Queued } from './offline-db';
import { round, withLoanEffects } from '../../shared/engine';
import type { Effect, Entry, Person } from '../../shared/types';

const PROJECTED_PREFIX = 'offline:';

export function isProjectedEntry(entry: Pick<Entry, 'id'>): boolean {
  return entry.id.startsWith(PROJECTED_PREFIX);
}

/**
 * Build the view the user should see while writes are waiting to sync.
 *
 * The confirmed server snapshot is never mutated or rewritten.  Queued entries
 * are materialized as synthetic ledger rows and their effects are applied only
 * to a cloned balance snapshot.  Once the queue is gone, this function returns
 * the confirmed book unchanged.
 */
export function projectOfflineBook(confirmed: LoadedBook, queue: Queued[]): LoadedBook {
  if (!queue.length) return confirmed;

  const alreadyConfirmed = new Set(
    confirmed.entries
      .map((entry) => entry.clientRef)
      .filter((ref): ref is string => typeof ref === 'string' && !!ref),
  );

  const pending = [...queue]
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id))
    .filter((item) => {
      const ref = item.input.clientRef ?? item.id;
      return !alreadyConfirmed.has(ref);
    });

  if (!pending.length) return confirmed;

  const balances = {
    totalCash: confirmed.balances.totalCash,
    accounts: { ...confirmed.balances.accounts },
    businesses: { ...confirmed.balances.businesses },
    people: { ...confirmed.balances.people },
    loans: { ...confirmed.balances.loans },
    projects: { ...confirmed.balances.projects },
  };

  const projectedEntries: Entry[] = [];

  for (const item of pending) {
    const input = { ...item.input, clientRef: item.input.clientRef ?? item.id };
    const effects = withLoanEffects(input, confirmed);
    projectedEntries.push({
      ...input,
      id: `${PROJECTED_PREFIX}${item.id}`,
      effects,
      correctedFrom: null,
      transactionId: null,
      createdAt: item.queuedAt,
    });
    applyEffects(balances, effects, confirmed);
  }

  return {
    ...confirmed,
    entries: [...confirmed.entries, ...projectedEntries],
    balances,
  };
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

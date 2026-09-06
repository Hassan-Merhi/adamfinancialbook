import type { LoadedBook } from './api';
import type { OfflineEntryInput, OfflineSyncContext } from '../../shared/offline-conflict';

type MaybeLoadedBook = Partial<LoadedBook>;

function accountExpectation(book: MaybeLoadedBook, id: string | null | undefined) {
  if (!id || !Array.isArray(book.accounts)) return null;
  const account = book.accounts.find((item) => item.id === id);
  if (!account) return null;
  const balances = book.balances?.accounts;
  if (!balances || typeof balances[account.id] !== 'number') return null;
  return {
    id: account.id,
    businessId: account.businessId ?? null,
    balance: Number(balances[account.id]),
  };
}

/**
 * Capture the projected facts visible immediately before this queued write.
 * Phase 1 can still hydrate old/minimal snapshots created by earlier clients;
 * those remain queueable, but Phase 4 records only preconditions that actually
 * exist instead of assuming a fully shaped modern snapshot.
 */
export function captureOfflineContext(book: MaybeLoadedBook, input: OfflineEntryInput): OfflineSyncContext {
  const project = input.projectId && Array.isArray(book.projects)
    ? book.projects.find((item) => item.id === input.projectId)
    : null;
  const person = input.personId && Array.isArray(book.people)
    ? book.people.find((item) => item.id === input.personId)
    : null;
  const receipt = input.linkReceiptId && Array.isArray(book.receipts)
    ? book.receipts.find((item) => item.id === input.linkReceiptId)
    : null;
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    sourceAccount: accountExpectation(book, input.accountId),
    destinationAccount: accountExpectation(book, input.toAccountId),
    project: project ? { id: project.id, businessId: project.businessId } : null,
    person: person ? { id: person.id, businessId: person.businessId, kind: person.kind } : null,
    receipt: receipt ? {
      id: receipt.id,
      projectId: receipt.projectId,
      amount: receipt.amount,
      inCash: receipt.inCash,
    } : null,
  };
}

import type { LoadedBook } from './api';
import type { OfflineEntryInput, OfflineSyncContext } from '../../shared/offline-conflict';

function accountExpectation(book: LoadedBook, id: string | null | undefined) {
  if (!id) return null;
  const account = book.accounts.find((item) => item.id === id);
  if (!account) return null;
  return {
    id: account.id,
    businessId: account.businessId ?? null,
    balance: Number(book.balances.accounts[account.id] ?? 0),
  };
}

/** Capture the projected facts visible immediately before this queued write. */
export function captureOfflineContext(book: LoadedBook, input: OfflineEntryInput): OfflineSyncContext {
  const project = input.projectId ? book.projects.find((item) => item.id === input.projectId) : null;
  const person = input.personId ? book.people.find((item) => item.id === input.personId) : null;
  const receipt = input.linkReceiptId ? book.receipts.find((item) => item.id === input.linkReceiptId) : null;
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

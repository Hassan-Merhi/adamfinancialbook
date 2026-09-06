import type { EvidenceDashboard, LoadedBook } from './api';
import { receiptsNotInCash } from '../../shared/engine';
import { outbox } from './offline';

export interface AttentionCounts {
  reviews: number;
  approvals: number;
  transfers: number;
  reminders: number;
  receiptsWaiting: number;
  missingEvidence: number;
  syncConflicts: number;
  total: number;
}

/**
 * One definition of "needs attention" used by Today, More, and the hub itself.
 * Unread notifications are deliberately not counted: they are updates, while
 * this count is reserved for unresolved work. Phase 4 sync conflicts are real
 * unresolved financial work, so they are included even while offline.
 */
export function attentionCounts(
  book: LoadedBook,
  dashboard: EvidenceDashboard | null,
  missingEvidence = 0,
): AttentionCounts {
  const reviews = dashboard?.expenseReviews.length ?? 0;
  const approvals = dashboard?.approvals.filter((item) => item.status === 'pending').length ?? 0;
  const transfers = dashboard?.pendingTransfers.length ?? 0;
  const reminders = book.reminders.filter((item) => !item.settled).length;
  const receiptsWaiting = book.projects.reduce(
    (sum, project) => sum + receiptsNotInCash(book, project.id).length,
    0,
  );
  const syncConflicts = outbox.summary().conflicts;

  return {
    reviews,
    approvals,
    transfers,
    reminders,
    receiptsWaiting,
    missingEvidence,
    syncConflicts,
    total: reviews + approvals + transfers + reminders + receiptsWaiting + missingEvidence + syncConflicts,
  };
}

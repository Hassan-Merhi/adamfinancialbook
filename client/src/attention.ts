import type { EvidenceDashboard, LoadedBook } from './api';
import { receiptsNotInCash } from '../../shared/engine';

export interface AttentionCounts {
  reviews: number;
  approvals: number;
  transfers: number;
  reminders: number;
  receiptsWaiting: number;
  missingEvidence: number;
  total: number;
}

/**
 * One definition of "needs attention" used by Today, More, and the hub itself.
 * Unread notifications are deliberately not counted: they are updates, while
 * this count is reserved for unresolved work.
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

  return {
    reviews,
    approvals,
    transfers,
    reminders,
    receiptsWaiting,
    missingEvidence,
    total: reviews + approvals + transfers + reminders + receiptsWaiting + missingEvidence,
  };
}

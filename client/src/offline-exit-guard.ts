import { lastUser, outbox } from './offline';
import {
  OFFLINE_ATTACHMENT_EVENT,
  attachmentQueue,
  type OfflineAttachmentSummary,
} from './offline-attachments';
import { needsUnsyncedExitWarning, outstandingReceiptCount } from './offline-sync-ux';

const EMPTY: OfflineAttachmentSummary = { waiting: 0, uploading: 0, uploaded: 0, failed: 0, total: 0 };
let receipts = EMPTY;
let installed = false;

async function refreshReceipts(): Promise<void> {
  receipts = await attachmentQueue.summary().catch(() => EMPTY);
}

function activeUnsyncedCounts(): { entries: number; receipts: number } {
  if (!lastUser.load()) return { entries: 0, receipts: 0 };
  return { entries: outbox.all().length, receipts: outstandingReceiptCount(receipts) };
}

function hasUnsyncedWork(): boolean {
  const counts = activeUnsyncedCounts();
  return needsUnsyncedExitWarning(counts.entries, receipts);
}

function warningText(): string {
  const counts = activeUnsyncedCounts();
  const parts = [
    counts.entries ? `${counts.entries} unsynced ${counts.entries === 1 ? 'transaction' : 'transactions'}` : '',
    counts.receipts ? `${counts.receipts} unsynced ${counts.receipts === 1 ? 'receipt' : 'receipts'}` : '',
  ].filter(Boolean);
  return `${parts.join(' and ')} are still stored on this device. Signing out keeps them safe for this user, but they cannot sync until you sign in again. Sign out anyway?`;
}

export async function installOfflineExitGuards(): Promise<void> {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return;
  installed = true;
  await refreshReceipts();

  const attachmentChanged = () => { void refreshReceipts(); };
  window.addEventListener(OFFLINE_ATTACHMENT_EVENT, attachmentChanged);

  window.addEventListener('beforeunload', (event) => {
    if (!hasUnsyncedWork()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // App sign-out buttons are ordinary React click handlers. Capture first so a
  // cancelled warning prevents /api/logout from running at all.
  document.addEventListener('click', (event) => {
    const element = event.target instanceof Element
      ? event.target.closest('.more-signout, .railfoot .linkbtn')
      : null;
    if (!element || !hasUnsyncedWork()) return;
    if (window.confirm(warningText())) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }, true);
}

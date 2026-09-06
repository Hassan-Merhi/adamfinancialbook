import { lastUser } from './offline';
import { OFFLINE_ATTACHMENT_EVENT } from './offline-attachments';
import { OFFLINE_DB_NAME } from './offline-db';

type ActiveUser = { id: string };
const ATTACHMENTS = 'attachments';

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Offline reset transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Offline reset transaction aborted.'));
  });
}

/**
 * A successful server-side reset invalidates evidence queued against the old
 * financial book. Remove the current user's receipt blobs before reloading so
 * they cannot attach to newly-created records that happen to reuse a target.
 */
export async function clearCurrentUserOfflineAttachments(): Promise<void> {
  const userId = lastUser.load<ActiveUser>()?.id;
  if (!userId || typeof indexedDB === 'undefined') return;

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open offline receipt storage for reset.'));
  });

  try {
    if (!db.objectStoreNames.contains(ATTACHMENTS)) return;
    const transaction = db.transaction(ATTACHMENTS, 'readwrite');
    const store = transaction.objectStore(ATTACHMENTS);
    const index = store.index('by-user');
    const request = index.getAllKeys(IDBKeyRange.only(userId));
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not list queued receipts for reset.'));
    });
    for (const key of keys) store.delete(key);
    await transactionDone(transaction);
  } finally {
    db.close();
  }

  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent(OFFLINE_ATTACHMENT_EVENT));
  }
}

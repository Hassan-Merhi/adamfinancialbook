import type { OfflineAttachmentSummary } from './offline-attachments';
import type { SyncSummary } from './offline';

export interface CombinedSyncStatus {
  label: string;
  detail: string;
  tone: 'good' | 'warn' | 'bad';
  outstanding: number;
}

export function outstandingReceiptCount(summary: OfflineAttachmentSummary): number {
  return summary.waiting + summary.uploading + summary.failed;
}

export function outstandingSyncCount(entryCount: number, receipts: OfflineAttachmentSummary): number {
  return Math.max(0, entryCount) + outstandingReceiptCount(receipts);
}

export function needsUnsyncedExitWarning(entryCount: number, receipts: OfflineAttachmentSummary): boolean {
  return outstandingSyncCount(entryCount, receipts) > 0;
}

export function combinedSyncStatus(
  online: boolean,
  entryCount: number,
  sync: SyncSummary,
  receipts: OfflineAttachmentSummary,
): CombinedSyncStatus {
  const outstanding = outstandingSyncCount(entryCount, receipts);
  const failures = sync.conflicts + sync.rejected + sync.blockedAuth + receipts.failed;

  if (!online) {
    return {
      label: 'Offline',
      detail: outstanding ? `${outstanding} stored on this device` : 'Using the last confirmed book',
      tone: outstanding ? 'warn' : 'good',
      outstanding,
    };
  }
  if (failures > 0) {
    return {
      label: 'Needs attention',
      detail: `${failures} ${failures === 1 ? 'sync item needs' : 'sync items need'} review`,
      tone: 'bad',
      outstanding,
    };
  }
  if (sync.syncing > 0 || receipts.uploading > 0) {
    return {
      label: 'Syncing',
      detail: `${outstanding} ${outstanding === 1 ? 'item' : 'items'} remaining`,
      tone: 'warn',
      outstanding,
    };
  }
  if (outstanding > 0) {
    return {
      label: 'Sync pending',
      detail: `${outstanding} ${outstanding === 1 ? 'item' : 'items'} stored safely`,
      tone: 'warn',
      outstanding,
    };
  }
  return { label: 'All synced', detail: 'Server and this device are caught up', tone: 'good', outstanding: 0 };
}

export function latestSyncTime(sync: SyncSummary, uploadedAt: Array<string | null | undefined>): string | null {
  const values = [sync.lastSuccessAt, ...uploadedAt]
    .filter((value): value is string => typeof value === 'string' && !!value)
    .sort();
  return values.length ? values[values.length - 1] : null;
}

export function readableSyncTime(value: string | null, now = Date.now()): string {
  if (!value) return 'Not synced yet';
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return 'Unknown';
  const age = Math.max(0, now - at);
  if (age < 60_000) return 'Just now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return new Date(at).toLocaleString();
}

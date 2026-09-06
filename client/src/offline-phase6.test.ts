import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SyncSummary } from './offline';
import type { OfflineAttachmentSummary } from './offline-attachments';
import {
  combinedSyncStatus,
  latestSyncTime,
  needsUnsyncedExitWarning,
  outstandingSyncCount,
  readableSyncTime,
} from './offline-sync-ux';

const sync = (patch: Partial<SyncSummary> = {}): SyncSummary => ({
  pending: 0,
  syncing: 0,
  retrying: 0,
  blockedAuth: 0,
  conflicts: 0,
  rejected: 0,
  blockedByOrder: 0,
  nextRetryAt: null,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  ...patch,
});

const receipts = (patch: Partial<OfflineAttachmentSummary> = {}): OfflineAttachmentSummary => ({
  waiting: 0,
  uploading: 0,
  uploaded: 0,
  failed: 0,
  total: 0,
  ...patch,
});

describe('Offline Phase 6 sync UX', () => {
  it('combines entry and receipt work without counting already-uploaded evidence', () => {
    const files = receipts({ waiting: 2, uploading: 1, uploaded: 9, failed: 1, total: 13 });
    expect(outstandingSyncCount(3, files)).toBe(7);
    expect(needsUnsyncedExitWarning(0, receipts({ uploaded: 4, total: 4 }))).toBe(false);
    expect(needsUnsyncedExitWarning(1, receipts())).toBe(true);
    expect(needsUnsyncedExitWarning(0, receipts({ failed: 1, total: 1 }))).toBe(true);
  });

  it('prioritizes offline and human-review states over ordinary pending work', () => {
    expect(combinedSyncStatus(false, 2, sync({ conflicts: 1 }), receipts()).label).toBe('Offline');
    expect(combinedSyncStatus(true, 2, sync({ conflicts: 1 }), receipts()).label).toBe('Needs attention');
    expect(combinedSyncStatus(true, 1, sync({ retrying: 1 }), receipts()).label).toBe('Sync pending');
    expect(combinedSyncStatus(true, 0, sync(), receipts()).label).toBe('All synced');
  });

  it('uses the newest successful entry or receipt timestamp for Last synced', () => {
    const state = sync({ lastSuccessAt: '2026-09-06T08:00:00.000Z' });
    expect(latestSyncTime(state, ['2026-09-06T08:05:00.000Z', null])).toBe('2026-09-06T08:05:00.000Z');
    expect(readableSyncTime('2026-09-06T08:05:00.000Z', Date.parse('2026-09-06T08:05:20.000Z'))).toBe('Just now');
  });

  it('keeps the Phase 6 safety/UX contracts in the production wiring', () => {
    const center = readFileSync(new URL('./OfflineAttachmentStatus.tsx', import.meta.url), 'utf8');
    const guard = readFileSync(new URL('./offline-exit-guard.ts', import.meta.url), 'utf8');
    const reset = readFileSync(new URL('./views/ResetData.tsx', import.meta.url), 'utf8');
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');

    expect(center).toContain('aria-label="Sync Center"');
    expect(center).toContain('Server confirmed');
    expect(center).toContain('Projected on this device');
    expect(center).toContain('Transactions on this device');
    expect(center).toContain('Receipts on this device');
    expect(center).toContain('Use latest &amp; retry');
    expect(center).toContain('Retry failed receipts');
    expect(center).toContain('Sync now');

    expect(guard).toContain("window.addEventListener('beforeunload'");
    expect(guard).toContain("closest('.more-signout, .railfoot .linkbtn')");
    expect(guard).toContain('Signing out keeps them safe for this user');
    expect(main).toContain('await installOfflineExitGuards();');

    expect(reset).toContain('await outbox.clear();');
    expect(reset).toContain('await clearCurrentUserOfflineAttachments();');
    expect(reset.indexOf('await outbox.clear();')).toBeLessThan(reset.indexOf('window.location.reload();'));
    expect(reset.indexOf('await clearCurrentUserOfflineAttachments();')).toBeLessThan(reset.indexOf('window.location.reload();'));
  });
});

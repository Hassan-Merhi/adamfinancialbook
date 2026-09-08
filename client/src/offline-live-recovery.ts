import {
  OFFLINE_AUTO_SYNC_EVENT,
  flushOutbox,
  outbox,
  sendOfflineQueued,
  type OfflineAutoSyncResult,
} from './offline';
import { flushOfflineAttachments } from './offline-attachments';
import {
  LIVE_RECOVERY_EVENT,
  type LiveRecoveryDetail,
  type LiveRecoveryReason,
} from './live-recovery';

export interface DurableRecoveryWork {
  ledger: boolean;
  attachments: boolean;
}

export function durableRecoveryWork(
  reason: LiveRecoveryReason,
  pendingLedger: number,
  online: boolean,
): DurableRecoveryWork {
  if (!online || reason === 'online') return { ledger: false, attachments: false };
  return {
    ledger: pendingLedger > 0,
    // Receipt storage owns its normal online/focus listeners. The live recovery
    // bridge covers the two gaps those listeners can miss: an SSE reconnect or
    // a long mobile resume that did not produce a clean offline/online edge.
    attachments: true,
  };
}

export function shouldFlushOnLiveRecovery(
  reason: LiveRecoveryReason,
  pending: number,
  online: boolean,
): boolean {
  return durableRecoveryWork(reason, pending, online).ledger;
}

function emit(target: Window, detail: OfflineAutoSyncResult): void {
  target.dispatchEvent(new CustomEvent<OfflineAutoSyncResult>(OFFLINE_AUTO_SYNC_EVENT, { detail }));
}

/**
 * Bridge transport recovery to every durable offline queue.
 *
 * Both ledger and receipt flushers are single-flight and idempotent. Waking
 * them after a stream reconnect/mobile resume is therefore safe even when a
 * retry timer is already scheduled. Normal browser `online` handling remains
 * owned by App.tsx/offline-attachments.ts so one outage does not get duplicate
 * explicit recovery work from this bridge.
 *
 * The two queues intentionally recover independently: a receipt-storage error
 * must never make a successfully posted financial entry look like it failed.
 */
export function installOfflineLiveRecovery(target: Window = window): () => void {
  const recover = (event: Event) => {
    const detail = (event as CustomEvent<LiveRecoveryDetail>).detail;
    if (!detail) return;

    const work = durableRecoveryWork(detail.reason, outbox.all().length, target.navigator.onLine);
    if (!work.ledger && !work.attachments) return;

    if (work.ledger) {
      void flushOutbox(sendOfflineQueued)
        .then((sent) => {
          if (sent) emit(target, { sent, error: null });
        })
        .catch((error) => emit(target, {
          sent: 0,
          error: error instanceof Error ? error.message : String(error),
        }));
    }

    if (work.attachments) {
      // Attachment attempt() persists retry/failure state itself. Catch the
      // outer storage failure here so it cannot become an unhandled rejection
      // or contaminate the ledger sync result.
      void flushOfflineAttachments().catch(() => undefined);
    }
  };

  target.addEventListener(LIVE_RECOVERY_EVENT, recover);
  return () => target.removeEventListener(LIVE_RECOVERY_EVENT, recover);
}

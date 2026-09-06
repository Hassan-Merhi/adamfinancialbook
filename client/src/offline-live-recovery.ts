import {
  OFFLINE_AUTO_SYNC_EVENT,
  flushOutbox,
  outbox,
  sendOfflineQueued,
  type OfflineAutoSyncResult,
} from './offline';
import {
  LIVE_RECOVERY_EVENT,
  type LiveRecoveryDetail,
  type LiveRecoveryReason,
} from './live-recovery';

export function shouldFlushOnLiveRecovery(
  reason: LiveRecoveryReason,
  pending: number,
  online: boolean,
): boolean {
  // App.tsx already owns the explicit browser `online` flush. Recovery-only
  // triggers cover transport reconnects and mobile resume, where a suspended
  // retry timer may otherwise not get another immediate chance to run.
  return online && pending > 0 && reason !== 'online';
}

function emit(target: Window, detail: OfflineAutoSyncResult): void {
  target.dispatchEvent(new CustomEvent<OfflineAutoSyncResult>(OFFLINE_AUTO_SYNC_EVENT, { detail }));
}

/**
 * Phase 5 bridge between the live transport and the durable financial outbox.
 * flushOutbox is single-flight, preserves strict queue order, and never drops a
 * failed row, so nudging it on resume/reconnect is safe and idempotent.
 */
export function installOfflineLiveRecovery(target: Window = window): () => void {
  const recover = (event: Event) => {
    const detail = (event as CustomEvent<LiveRecoveryDetail>).detail;
    if (!detail || !shouldFlushOnLiveRecovery(detail.reason, outbox.all().length, target.navigator.onLine)) return;

    void flushOutbox(sendOfflineQueued)
      .then((sent) => {
        if (sent) emit(target, { sent, error: null });
      })
      .catch((error) => emit(target, {
        sent: 0,
        error: error instanceof Error ? error.message : String(error),
      }));
  };

  target.addEventListener(LIVE_RECOVERY_EVENT, recover);
  return () => target.removeEventListener(LIVE_RECOVERY_EVENT, recover);
}

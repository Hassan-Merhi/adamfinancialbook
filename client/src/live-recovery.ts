export type LiveRecoveryReason = 'online' | 'stream-reconnected' | 'resume';

export const LIVE_RECOVERY_EVENT = 'book:live-recovery';
export const LIVE_RESUME_GAP_MS = 15_000;

export interface LiveRecoveryDetail {
  reason: LiveRecoveryReason;
  at: number;
}

/**
 * Tracks periods where server push may have been interrupted. SSE intentionally
 * does not attempt to replay financial events: after a gap the client performs
 * one authoritative revalidation instead.
 */
export class LiveGapTracker {
  private streamGap = false;
  private hiddenAt: number | null = null;

  offline(): void {
    this.streamGap = true;
  }

  online(): LiveRecoveryReason {
    // The browser explicitly crossed an offline boundary. The online recovery
    // itself covers the gap, so the following SSE open must not trigger a
    // second recovery for the same outage.
    this.streamGap = false;
    return 'online';
  }

  streamError(): void {
    this.streamGap = true;
  }

  streamOpen(): LiveRecoveryReason | null {
    if (!this.streamGap) return null;
    this.streamGap = false;
    return 'stream-reconnected';
  }

  hidden(now: number): void {
    this.hiddenAt = now;
  }

  visible(now: number): LiveRecoveryReason | null {
    const hiddenAt = this.hiddenAt;
    this.hiddenAt = null;
    if (hiddenAt == null || now - hiddenAt < LIVE_RESUME_GAP_MS) return null;
    return 'resume';
  }
}

export function dispatchLiveRecovery(
  target: Window,
  reason: LiveRecoveryReason,
  at = Date.now(),
): void {
  target.dispatchEvent(new CustomEvent<LiveRecoveryDetail>(LIVE_RECOVERY_EVENT, {
    detail: { reason, at },
  }));
}

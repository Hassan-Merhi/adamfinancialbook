import { describe, expect, it } from 'vitest';
import { LIVE_RESUME_GAP_MS, LiveGapTracker } from './live-recovery';

describe('live reconnect recovery', () => {
  it('does not refresh again on the first healthy stream open', () => {
    const tracker = new LiveGapTracker();
    expect(tracker.streamOpen()).toBeNull();
  });

  it('recovers once after an explicit browser offline/online transition', () => {
    const tracker = new LiveGapTracker();
    tracker.offline();
    expect(tracker.online()).toBe('online');
    expect(tracker.streamOpen()).toBeNull();
  });

  it('recovers when EventSource reconnects after a transport-only gap', () => {
    const tracker = new LiveGapTracker();
    tracker.streamError();
    expect(tracker.streamOpen()).toBe('stream-reconnected');
    expect(tracker.streamOpen()).toBeNull();
  });

  it('only treats a meaningful mobile background suspension as a recovery gap', () => {
    const tracker = new LiveGapTracker();
    tracker.hidden(1_000);
    expect(tracker.visible(1_000 + LIVE_RESUME_GAP_MS - 1)).toBeNull();

    tracker.hidden(10_000);
    expect(tracker.visible(10_000 + LIVE_RESUME_GAP_MS)).toBe('resume');
    expect(tracker.visible(10_000 + LIVE_RESUME_GAP_MS + 1)).toBeNull();
  });

  it('still permits an EventSource recovery after a background refresh attempt', () => {
    const tracker = new LiveGapTracker();
    tracker.streamError();
    tracker.hidden(5_000);
    expect(tracker.visible(5_000 + LIVE_RESUME_GAP_MS)).toBe('resume');
    expect(tracker.streamOpen()).toBe('stream-reconnected');
  });
});

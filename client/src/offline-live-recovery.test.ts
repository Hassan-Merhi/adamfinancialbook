import { describe, expect, it } from 'vitest';
import { shouldFlushOnLiveRecovery } from './offline-live-recovery';

describe('offline live recovery', () => {
  it('does not duplicate the normal online-event outbox flush', () => {
    expect(shouldFlushOnLiveRecovery('online', 2, true)).toBe(false);
  });

  it('nudges pending durable work after a transport reconnect', () => {
    expect(shouldFlushOnLiveRecovery('stream-reconnected', 2, true)).toBe(true);
  });

  it('nudges pending durable work after a long mobile resume', () => {
    expect(shouldFlushOnLiveRecovery('resume', 1, true)).toBe(true);
  });

  it('never tries to flush with no work or while actually offline', () => {
    expect(shouldFlushOnLiveRecovery('resume', 0, true)).toBe(false);
    expect(shouldFlushOnLiveRecovery('stream-reconnected', 3, false)).toBe(false);
  });
});

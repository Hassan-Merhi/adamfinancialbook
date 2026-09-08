import { describe, expect, it } from 'vitest';
import { durableRecoveryWork, shouldFlushOnLiveRecovery } from './offline-live-recovery';

describe('offline live recovery', () => {
  it('does not duplicate the normal online-event outbox flush', () => {
    expect(shouldFlushOnLiveRecovery('online', 2, true)).toBe(false);
    expect(durableRecoveryWork('online', 2, true)).toEqual({ ledger: false, attachments: false });
  });

  it('nudges pending durable work after a transport reconnect', () => {
    expect(shouldFlushOnLiveRecovery('stream-reconnected', 2, true)).toBe(true);
    expect(durableRecoveryWork('stream-reconnected', 2, true)).toEqual({ ledger: true, attachments: true });
  });

  it('nudges pending durable work after a long mobile resume', () => {
    expect(shouldFlushOnLiveRecovery('resume', 1, true)).toBe(true);
    expect(durableRecoveryWork('resume', 1, true)).toEqual({ ledger: true, attachments: true });
  });

  it('still wakes receipts on reconnect when there are no ledger rows', () => {
    expect(durableRecoveryWork('stream-reconnected', 0, true)).toEqual({ ledger: false, attachments: true });
    expect(durableRecoveryWork('resume', 0, true)).toEqual({ ledger: false, attachments: true });
  });

  it('never tries to recover durable work while actually offline', () => {
    expect(shouldFlushOnLiveRecovery('resume', 3, false)).toBe(false);
    expect(durableRecoveryWork('resume', 3, false)).toEqual({ ledger: false, attachments: false });
    expect(durableRecoveryWork('stream-reconnected', 0, false)).toEqual({ ledger: false, attachments: false });
  });
});

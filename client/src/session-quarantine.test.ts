import { describe, expect, it } from 'vitest';
import { shouldQuarantineOfflineIdentity } from './session-quarantine';

describe('Phase 6 offline identity quarantine policy', () => {
  it('quarantines cached offline identity after protected session rejection', () => {
    expect(shouldQuarantineOfflineIdentity('/api/overview', 401)).toBe(true);
    expect(shouldQuarantineOfflineIdentity('/api/entries', 401)).toBe(true);
    expect(shouldQuarantineOfflineIdentity('/api/security/sessions', 401)).toBe(true);
  });

  it('does not mistake a wrong credential check for session revocation', () => {
    expect(shouldQuarantineOfflineIdentity('/api/login', 401)).toBe(false);
    expect(shouldQuarantineOfflineIdentity('/api/security/reauth', 401)).toBe(false);
    expect(shouldQuarantineOfflineIdentity('/api/password', 401)).toBe(false);
  });

  it('ignores non-401 responses and non-api requests', () => {
    expect(shouldQuarantineOfflineIdentity('/api/overview', 403)).toBe(false);
    expect(shouldQuarantineOfflineIdentity('/api/overview', 500)).toBe(false);
    expect(shouldQuarantineOfflineIdentity('/assets/app.js', 401)).toBe(false);
  });
});

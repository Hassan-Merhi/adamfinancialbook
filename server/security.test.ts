import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { passwordComplaint, readSession, signSession } from './session.js';
import {
  decryptMfaSecret,
  encryptMfaSecret,
  sessionSeconds,
  verifyTotp,
} from './security.js';

describe('Phase 6 security primitives', () => {
  const originalSecret = process.env.SESSION_SECRET;

  beforeEach(() => {
    process.env.SESSION_SECRET = 'phase-6-test-secret-that-is-definitely-long-enough';
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  });

  it('uses shorter sessions for delegated users than owners', () => {
    expect(sessionSeconds('entry')).toBe(24 * 60 * 60);
    expect(sessionSeconds('owner')).toBe(7 * 24 * 60 * 60);
    expect(sessionSeconds('entry')).toBeLessThan(sessionSeconds('owner'));
  });

  it('reads tracked and legacy signed cookies without accepting tampering', () => {
    const expires = Date.now() + 60_000;
    const tracked = signSession('usr_one', 3, 'sid_test', expires);
    expect(readSession(tracked)).toEqual({
      userId: 'usr_one', version: 3, sessionId: 'sid_test', expiresAt: expires,
    });

    const legacy = signSession('usr_old', 2, undefined, expires);
    expect(readSession(legacy)).toEqual({
      userId: 'usr_old', version: 2, sessionId: undefined, expiresAt: expires,
    });
    expect(readSession(`${tracked.slice(0, -1)}x`)).toBeNull();
  });

  it('enforces the stronger password baseline while allowing long passphrases', () => {
    expect(passwordComplaint('short')).toContain('12');
    expect(passwordComplaint('lowercaseonly')).not.toBeNull();
    expect(passwordComplaint('Correct-Horse-Battery-Staple')).toBeNull();
    expect(passwordComplaint('GoodPass!2026')).toBeNull();
  });

  it('verifies standards-compatible TOTP codes with clock skew tolerance', () => {
    // RFC 6238 SHA-1 test secret. The standard 8-digit code at t=59 is
    // 94287082, so the six-digit form used by authenticator apps is 287082.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(verifyTotp(secret, '287082', 59_000)).toBe(true);
    expect(verifyTotp(secret, '287082', 89_000)).toBe(true);
    expect(verifyTotp(secret, '000000', 59_000)).toBe(false);
  });

  it('encrypts MFA secrets at rest and decrypts them with the server key', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const encrypted = encryptMfaSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptMfaSecret(encrypted)).toBe(secret);
  });
});

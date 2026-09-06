import { describe, expect, it } from 'vitest';
import { audienceAllows, type LiveAudience } from './live-audience';

const owner = { userId: 'owner_1', role: 'owner' as const };
const alice = { userId: 'user_a', role: 'entry' as const };
const bob = { userId: 'user_b', role: 'entry' as const };

describe('permission-aware realtime audiences', () => {
  it('keeps account-specific invalidations away from unrelated delegates', () => {
    const audience: LiveAudience = { all: false, owners: true, userIds: ['user_a'] };
    expect(audienceAllows(audience, owner)).toBe(true);
    expect(audienceAllows(audience, alice)).toBe(true);
    expect(audienceAllows(audience, bob)).toBe(false);
  });

  it('can target one delegate without exposing the target list to client code', () => {
    const audience: LiveAudience = { all: false, owners: false, userIds: ['user_b'] };
    expect(audienceAllows(audience, owner)).toBe(false);
    expect(audienceAllows(audience, alice)).toBe(false);
    expect(audienceAllows(audience, bob)).toBe(true);
  });

  it('allows explicit all-user invalidation for a full book reset', () => {
    const audience: LiveAudience = { all: true, owners: true, userIds: [] };
    expect(audienceAllows(audience, owner)).toBe(true);
    expect(audienceAllows(audience, alice)).toBe(true);
    expect(audienceAllows(audience, bob)).toBe(true);
  });
});

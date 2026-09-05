import { describe, expect, it } from 'vitest';
import { normalizePinnedAccounts, togglePinnedAccount } from './favorites';

describe('pinned account preferences', () => {
  it('keeps only unique account ids that still exist', () => {
    expect(normalizePinnedAccounts(['a', 'gone', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b']);
  });

  it('pins newest accounts first and unpins an existing account', () => {
    expect(togglePinnedAccount(['a'], 'b', ['a', 'b'])).toEqual(['b', 'a']);
    expect(togglePinnedAccount(['b', 'a'], 'b', ['a', 'b'])).toEqual(['a']);
  });

  it('caps the quick list so it stays useful', () => {
    const valid = Array.from({ length: 12 }, (_, index) => `a${index}`);
    expect(normalizePinnedAccounts(valid, valid)).toHaveLength(8);
  });
});

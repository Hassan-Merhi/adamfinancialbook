import { describe, expect, it } from 'vitest';
import { liveEventMatches } from './live-subscription';
import type { LiveMutationDetail } from './live-refresh';

const detail = (topics: LiveMutationDetail['topics']): LiveMutationDetail => ({
  book: true,
  dashboard: true,
  topics,
  path: '/api/live-updates',
  method: 'REMOTE',
  at: 1,
});

describe('live topic subscriptions', () => {
  it('matches only the datasets a mounted page owns', () => {
    expect(liveEventMatches(detail(['approvals', 'history']), ['approvals'])).toBe(true);
    expect(liveEventMatches(detail(['approvals', 'history']), ['files'])).toBe(false);
    expect(liveEventMatches(detail(['files']), ['files', 'access'])).toBe(true);
  });

  it('ignores missing or empty topic signals', () => {
    expect(liveEventMatches(undefined, ['history'])).toBe(false);
    expect(liveEventMatches(detail([]), ['history'])).toBe(false);
    expect(liveEventMatches(detail(['history']), [])).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { classifyLiveMutation } from '../shared/live-updates';

describe('server live update safety', () => {
  it('does not treat failed/read-only paths as mutation topics', () => {
    expect(classifyLiveMutation('/api/overview', 'GET')).toBeNull();
    expect(classifyLiveMutation('/api/live-updates', 'GET')).toBeNull();
  });

  it('separates dashboard-only updates from financial-book updates', () => {
    expect(classifyLiveMutation('/api/delegation/approvals/a/decision', 'POST'))
      .toEqual({ book: false, dashboard: true });
    expect(classifyLiveMutation('/api/delegation/transfers/t/confirm', 'POST'))
      .toEqual({ book: true, dashboard: true });
  });
});

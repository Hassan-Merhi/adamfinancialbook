import { describe, expect, it } from 'vitest';
import { readPromptAction } from './prompt-actions';
import type { Catalog } from './types';

const empty: Catalog = { businesses: [], accounts: [], projects: [], receipts: [], people: [], loans: [] };

describe('Needs Attention prompt navigation', () => {
  it('opens the unified hub from natural commands', () => {
    expect(readPromptAction('needs attention', empty)).toEqual({ mode: 'view', view: 'attention', label: 'Needs attention' });
    expect(readPromptAction('open pending items', empty)).toEqual({ mode: 'view', view: 'attention', label: 'Needs attention' });
  });
});

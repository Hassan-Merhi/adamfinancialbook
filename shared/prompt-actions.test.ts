import { describe, expect, it } from 'vitest';
import { readPromptAction } from './prompt-actions.js';
import type { Catalog } from './types.js';

const catalog: Catalog = {
  businesses: [
    { id: 'con', name: 'Construction' },
    { id: 'mot', name: 'Huanghe Motors' },
  ],
  accounts: [
    { id: 'con_cash', name: 'Construction Cash', businessId: 'con', opening: 20_000 },
    { id: 'mot_cash', name: 'Motors Cash', businessId: 'mot', opening: 3_000 },
  ],
  projects: [{ id: 'kin', name: 'Kin Severe', scope: 'Factory', businessId: 'con' }],
  receipts: [],
  people: [
    { id: 'dani', name: 'Dani Hardware', role: 'Supplier', businessId: 'con', kind: 'payable', opening: 0, salary: 0 },
  ],
  loans: [],
};

describe('prompt-first navigation', () => {
  it('opens primary and secondary pages from natural commands', () => {
    expect(readPromptAction('go to projects', catalog)).toMatchObject({ mode: 'view', view: 'projects' });
    expect(readPromptAction('open day report', catalog)).toMatchObject({ mode: 'view', view: 'report' });
    expect(readPromptAction('show my wallet', catalog)).toMatchObject({ mode: 'view', view: 'approvals' });
    expect(readPromptAction('settings', catalog)).toMatchObject({ mode: 'view', view: 'setup' });
    expect(readPromptAction('more', catalog)).toMatchObject({ mode: 'view', view: 'more' });
  });

  it('opens statements by the names people already use', () => {
    expect(readPromptAction('show construction cash', catalog)).toEqual({
      mode: 'focus', target: { type: 'account', id: 'con_cash' }, label: 'Construction Cash',
    });
    expect(readPromptAction('show Dani', catalog)).toEqual({
      mode: 'focus', target: { type: 'person', id: 'dani' }, label: 'Dani Hardware',
    });
    expect(readPromptAction('open Kin Severe', catalog)).toEqual({
      mode: 'focus', target: { type: 'project', id: 'kin' }, label: 'Kin Severe',
    });
  });

  it('shows a named business through Money', () => {
    expect(readPromptAction('show Construction', catalog)).toEqual({
      mode: 'view', view: 'money', label: 'Construction money',
    });
  });

  it('does not hijack transactions or setup commands', () => {
    expect(readPromptAction('$900 fuel construction cash', catalog)).toBeNull();
    expect(readPromptAction('move $500 from construction cash to motors cash', catalog)).toBeNull();
    expect(readPromptAction('add account Rawbank under Construction', catalog)).toBeNull();
    expect(readPromptAction('open account Rawbank under Construction', catalog)).toBeNull();
  });
});

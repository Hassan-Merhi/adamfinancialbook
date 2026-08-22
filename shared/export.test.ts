import { describe, expect, it } from 'vitest';
import { backup, entriesCsv } from '../server/export.js';
import { accountBalance, withLoanEffects } from './engine.js';
import type { Book, EntryInput } from './types.js';

function book(): Book {
  return {
    businesses: [{ id: 'con', name: 'Construction' }],
    accounts: [{ id: 'con_cash', name: 'Construction Cash', businessId: 'con', opening: 10_000 }],
    projects: [{ id: 'kin', name: 'Kin Severe', scope: 'Factory', businessId: 'con' }],
    receipts: [],
    people: [],
    loans: [],
    reminders: [],
    entries: [],
  };
}

let seq = 0;
function log(b: Book, input: EntryInput, extra: Partial<{ voided: boolean; voidReason: string }> = {}) {
  const entry = {
    id: `e${++seq}`, ...input, effects: withLoanEffects(input, b),
    correctedFrom: null, createdAt: '2026-08-22T09:00:00Z', ...extra,
  };
  b.entries.push(entry);
  return entry;
}

describe('a voided entry', () => {
  it('stops counting but keeps its place', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-22', kind: 'expense', amount: 900, purpose: 'Wrong one', raw: '', accountId: 'con_cash' },
      { voided: true, voidReason: 'Logged against the wrong account' });
    log(b, { occurredOn: '2026-08-22', kind: 'expense', amount: 100, purpose: 'Real one', raw: '', accountId: 'con_cash' });

    expect(accountBalance(b, 'con_cash')).toBe(9_900);   // only the real one
    expect(b.entries).toHaveLength(2);                    // both still there
  });
});

describe('the spreadsheet', () => {
  it('has a row per entry, with names rather than ids', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-22', kind: 'expense', amount: 900, purpose: 'STS chargeuse', raw: '$900 STS', accountId: 'con_cash', projectId: 'kin' });

    const csv = entriesCsv(b);
    const [head, row] = csv.split('\n');
    expect(head).toContain('Date,Type,Purpose,Amount,Account');
    expect(row).toContain('Construction Cash');
    expect(row).toContain('Kin Severe');
    expect(row).not.toContain('con_cash');
  });

  it('keeps a comma or a quote inside its cell', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-22', kind: 'expense', amount: 5, purpose: 'Sand, gravel and "the rest"', raw: '', accountId: 'con_cash' });
    const row = entriesCsv(b).split('\n')[1];
    expect(row).toContain('"Sand, gravel and ""the rest"""');
    expect(row.split('\n')).toHaveLength(1);
  });

  it('will not let a purpose act as a formula', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-22', kind: 'expense', amount: 5, purpose: '=SUM(A1:A9)', raw: '', accountId: 'con_cash' });
    expect(entriesCsv(b).split('\n')[1]).toContain("'=SUM(A1:A9)");
  });
});

describe('the backup', () => {
  it('is the whole book, and can be read back', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-22', kind: 'expense', amount: 900, purpose: 'One', raw: '', accountId: 'con_cash' });

    const parsed = JSON.parse(backup(b));
    expect(parsed.version).toBe(1);
    expect(parsed.takenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.book.entries[0].effects[0].delta).toBe(-900);
    expect(accountBalance(parsed.book, 'con_cash')).toBe(9_100);   // figures survive the trip
  });
});

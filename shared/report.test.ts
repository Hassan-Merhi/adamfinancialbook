import { describe, expect, it } from 'vitest';
import { dayHeadline, dayReport } from '../server/report.js';
import { withLoanEffects } from './engine.js';
import type { Book, EntryInput } from './types.js';

function book(): Book {
  return {
    businesses: [{ id: 'con', name: 'Construction' }, { id: 'mot', name: 'Motors' }],
    accounts: [
      { id: 'con_cash', name: 'Construction Cash', businessId: 'con', opening: 10_000 },
      { id: 'mot_cash', name: 'Motors Cash', businessId: 'mot', opening: 2_000 },
    ],
    projects: [{ id: 'kin', name: 'Kin Severe', scope: 'Factory', businessId: 'con' }],
    receipts: [],
    people: [{ id: 'dani', name: 'Dani', role: 'Supplier', businessId: 'con', kind: 'payable', opening: 0, salary: 0 }],
    loans: [{ id: 'l1', fromBusiness: 'con', toBusiness: 'mot', opening: 7_000 }],
    reminders: [{ id: 'r1', what: 'Transport for the container', amount: 11_550, accountId: null, note: '', settled: false }],
    entries: [],
  };
}

let seq = 0;
function log(b: Book, input: EntryInput) {
  b.entries.push({
    id: `e${++seq}`, ...input, effects: withLoanEffects(input, b),
    correctedFrom: null, createdAt: `2026-08-22T00:00:0${seq}Z`,
  });
}

describe('the day report, in words', () => {
  it('says what came in, what went out, and what is still owed', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-22', kind: 'expense', amount: 900, purpose: 'STS chargeuse', raw: '', accountId: 'con_cash' });
    log(b, { occurredOn: '2026-08-22', kind: 'receipt', amount: 20_000, purpose: 'Kin Severe receipt', raw: '', accountId: 'con_cash', projectId: 'kin' });
    log(b, { occurredOn: '2026-08-22', kind: 'credit_purchase', amount: 1_000, purpose: 'Steel', raw: '', personId: 'dani' });
    log(b, { occurredOn: '2026-08-22', kind: 'transfer', amount: 500, purpose: 'Float', raw: '', accountId: 'con_cash', toAccountId: 'mot_cash' });

    const text = dayReport(b, '2026-08-22');
    expect(text).toContain('Saturday 22 August 2026');
    expect(text).toContain('Construction: $28,600');
    expect(text).toContain('RECEIVED');
    expect(text).toContain('Kin Severe: +$20,000');
    expect(text).toContain('STS chargeuse: -$900');
    expect(text).toContain('TAKEN ON CREDIT — NOT PAID');
    expect(text).toContain('MOVED — NOT SPENT');
    expect(text).toContain('Dani: -$1,000 (you owe)');
    expect(text).toContain('Transport for the container');
  });

  it('reads a day that has not happened yet as the quiet day it is', () => {
    const text = dayReport(book(), '2026-08-22');
    expect(text).toContain('Nothing was entered on this day.');
    expect(text).toContain('Total: $12,000');
  });

  it('fits the day on one line', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-22', kind: 'expense', amount: 900, purpose: 'Fuel', raw: '', accountId: 'con_cash' });
    expect(dayHeadline(b, '2026-08-22')).toBe('Cash $11,100 · in $0 · out $900 · 1 entries');
  });
});

describe('a voided entry is not reported', () => {
  it('never appears as money spent, and does not count in the headline', () => {
    const b = book();
    log(b, { occurredOn: '2026-08-22', kind: 'expense', amount: 900, purpose: 'Real one', raw: '', accountId: 'con_cash' });
    const wrong = { occurredOn: '2026-08-22', kind: 'expense' as const, amount: 5_000, purpose: 'Wrong one', raw: '', accountId: 'con_cash' };
    b.entries.push({
      id: 'voided', ...wrong, effects: withLoanEffects(wrong, b),
      correctedFrom: null, voided: true, voidReason: 'Wrong account', createdAt: '2026-08-22T00:00:09Z',
    });

    const text = dayReport(b, '2026-08-22');
    expect(text).toContain('Real one: -$900');
    expect(text).not.toContain('Wrong one');
    expect(dayHeadline(b, '2026-08-22')).toContain('out $900');
  });
});

import { describe, expect, it } from 'vitest';
import { read, readAmount } from './parse.js';
import type { Catalog } from './types.js';

/** The catalog a sentence is read against — the book teaches the reader its words. */
const catalog: Catalog = {
  businesses: [
    { id: 'con', name: 'Construction' },
    { id: 'mot', name: 'Huanghe Motors' },
  ],
  accounts: [
    { id: 'con_cash', name: 'Construction Cash', businessId: 'con', opening: 20_000 },
    { id: 'soficom', name: 'Soficom', businessId: 'con', opening: 25_000 },
    { id: 'mot_cash', name: 'Motors Cash', businessId: 'mot', opening: 3_000 },
  ],
  projects: [{ id: 'kin', name: 'Kin Severe', scope: 'Factory', businessId: 'con' }],
  receipts: [],
  people: [
    { id: 'dani', name: 'Dani Hardware', role: 'Supplier', businessId: 'con', kind: 'payable', opening: 0, salary: 0 },
    { id: 'abo', name: 'Abo Sheker', role: 'Staff', businessId: 'con', kind: 'salary', opening: 0, salary: 400 },
    { id: 'danny', name: 'Danny Kanyinda', role: 'Personal loan', businessId: 'con', kind: 'receivable', opening: 0, salary: 0 },
  ],
  loans: [{ id: 'l1', fromBusiness: 'con', toBusiness: 'mot', opening: 0 }],
};

const TODAY = '2026-08-21';
const entry = (text: string) => {
  const draft = read(text, catalog, TODAY);
  if (draft.mode !== 'entry') throw new Error('expected a transaction, got setup');
  return draft;
};

describe('the way things are actually typed', () => {
  it('"$900 STS chargeuse construction cash"', () => {
    const d = entry('$900 STS chargeuse construction cash');
    expect(d.input.kind).toBe('expense');
    expect(d.input.amount).toBe(900);
    expect(d.input.accountId).toBe('con_cash');
    expect(d.input.purpose).toBe('STS chargeuse');
    expect(d.needs).toEqual([]);
  });

  it('"$250 filming for bikes from construction cash" pays for another business', () => {
    const d = entry('$250 filming for Huanghe Motors from construction cash');
    expect(d.input.accountId).toBe('con_cash');
    expect(d.input.forBusiness).toBe('mot');
  });

  it('"$25000 withdrawn from Soficom into construction cash" is a move, not a spend', () => {
    const d = entry('$25000 withdrawn from Soficom into construction cash');
    expect(d.input.kind).toBe('transfer');
    expect(d.input.accountId).toBe('soficom');
    expect(d.input.toAccountId).toBe('con_cash');
  });

  it('"$50000 collected from Kin Severe" is a receipt', () => {
    const d = entry('$50000 collected from Kin Severe');
    expect(d.input.kind).toBe('receipt');
    expect(d.input.projectId).toBe('kin');
    expect(d.input.amount).toBe(50_000);
  });

  it('"$400 Abo Sheker salary" finds the person and the kind', () => {
    const d = entry('$400 Abo Sheker salary');
    expect(d.input.kind).toBe('salary');
    expect(d.input.personId).toBe('abo');
  });

  it('"$2500 loan to Danny" lends rather than spends', () => {
    const d = entry('$2500 loan to Danny');
    expect(d.input.kind).toBe('person_loan');
    expect(d.input.personId).toBe('danny');
  });

  it('"$700 Dani paid" pays a supplier down', () => {
    const d = entry('$700 Dani paid');
    expect(d.input.kind).toBe('supplier_payment');
    expect(d.input.personId).toBe('dani');
  });
});

describe('buying on credit', () => {
  it('touches no account and asks who is owed', () => {
    const d = entry('i bought 1 ton of steel from Dani Hardware for $1000');
    expect(d.input.kind).toBe('credit_purchase');
    expect(d.input.accountId).toBeNull();
    expect(d.input.personId).toBe('dani');
    expect(d.input.amount).toBe(1_000);
  });

  it('will not save without someone to owe', () => {
    const d = entry('i bought 20 bags of cement for $600');
    expect(d.input.kind).toBe('credit_purchase');
    expect(d.needs).toContain('person');
  });
});

describe('a quantity is not a price', () => {
  it('reads "1 ton of bricks" as a quantity and asks for the amount', () => {
    const d = entry('i bought 1 ton of bricks from Dani Hardware');
    expect(d.input.amount).toBe(0);
    expect(d.quantity).toBe('1 ton');
    expect(d.needs).toContain('amount');
    expect(d.input.purpose).toContain('1 ton');
  });

  it('prefers the dollar figure over the count', () => {
    expect(readAmount('3 trucks of sand $1400').amount).toBe(1_400);
    expect(readAmount('12k transport').amount).toBe(12_000);
    expect(readAmount('$1,500 rent').amount).toBe(1_500);
  });
});

describe('a guess is never silent', () => {
  it('names the account it assumed', () => {
    const d = entry('$900 fuel');
    expect(d.input.accountId).toBe('con_cash');
    expect(d.guessed).toContain('account');
  });

  it('does not guess when the account was named', () => {
    const d = entry('$900 fuel from Soficom');
    expect(d.guessed).toEqual([]);
  });
});

describe('dates', () => {
  it('today unless told otherwise', () => {
    expect(entry('$100 airtime construction cash').input.occurredOn).toBe(TODAY);
  });

  it('reads a written date as history', () => {
    const d = entry('$50000 from Kin Severe 17/03/26');
    expect(d.input.occurredOn).toBe('2026-03-17');
    expect(d.input.historical).toBe(true);
  });

  it('understands yesterday', () => {
    expect(entry('$300 DGM construction cash yesterday').input.occurredOn).toBe('2026-08-20');
  });

  it('"back in March" is history, not today\'s cash', () => {
    const d = entry('back in March we received $33000 from Kin Severe');
    expect(d.input.occurredOn.slice(0, 7)).toBe('2026-03');
    expect(d.input.historical).toBe(true);
  });
});

describe('setting the book up in the same box', () => {
  it('creates a business', () => {
    const d = read('create a business called Border Depot', catalog, TODAY);
    expect(d.mode).toBe('setup');
    if (d.mode !== 'setup') return;
    expect(d.kind).toBe('business');
    expect(d.name).toBe('Border Depot');
  });

  it('creates an account with its opening balance, under the right business', () => {
    const d = read('add account Rawbank under Construction with $31000', catalog, TODAY);
    if (d.mode !== 'setup') throw new Error('expected setup');
    expect(d.kind).toBe('account');
    expect(d.name).toBe('Rawbank');
    expect(d.businessId).toBe('con');
    expect(d.amount).toBe(31_000);
  });

  it('creates a payroll worker with a salary', () => {
    const d = read('add payroll worker Hamza salary $400 under Construction', catalog, TODAY);
    if (d.mode !== 'setup') throw new Error('expected setup');
    expect(d.kind).toBe('payroll');
    expect(d.name).toBe('Hamza');
    expect(d.amount).toBe(400);
  });

  it('creates a supplier', () => {
    const d = read('add supplier Somika Plumbing under Construction', catalog, TODAY);
    if (d.mode !== 'setup') throw new Error('expected setup');
    expect(d.kind).toBe('supplier');
    expect(d.name).toBe('Somika Plumbing');
  });

  it('does not mistake a purchase for setting something up', () => {
    expect(read('$900 STS chargeuse construction cash', catalog, TODAY).mode).toBe('entry');
  });
});

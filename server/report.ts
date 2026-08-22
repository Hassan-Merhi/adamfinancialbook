/**
 * The day in words — the same report you read on screen and the one that
 * arrives on your phone at your cut-off time.
 */
import {
  accountBalance, businessCash, loanBalance, ordered, personBalance, totalCash,
} from '../shared/engine.js';
import type { Book, Entry } from '../shared/types.js';

const money = (v: number) =>
  (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

export function dayReport(book: Book, date: string): string {
  const out: string[] = [];
  // ordered() leaves out voided entries, so a voided one is never reported as spent
  const day = ordered(book.entries).filter((e) => e.occurredOn === date);
  const name = (id: string | null | undefined, list: { id: string; name: string }[]) =>
    list.find((x) => x.id === id)?.name ?? '';

  out.push(longDate(date), '');

  out.push('CASH');
  for (const b of book.businesses) out.push(`  ${b.name}: ${money(businessCash(book, b.id, date))}`);
  out.push(`  Total: ${money(totalCash(book, date))}`, '');

  const section = (title: string, rows: string[]) => {
    if (!rows.length) return;
    out.push(title, ...rows.map((r) => `  ${r}`), '');
  };

  section('RECEIVED', day
    .filter((e) => e.kind === 'receipt' && !e.historical)
    .map((e) => `${name(e.projectId, book.projects) || e.purpose}: +${money(e.amount)}`));

  section('SPENT', day
    .filter((e) => !e.historical && ['expense', 'salary', 'person_loan', 'supplier_payment'].includes(e.kind))
    .map((e) => `${e.purpose}: -${money(e.amount)}${e.accountId ? ` (${name(e.accountId, book.accounts)})` : ''}`));

  section('TAKEN ON CREDIT — NOT PAID', day
    .filter((e) => e.kind === 'credit_purchase')
    .map((e) => `${e.purpose}: ${money(e.amount)} — ${name(e.personId, book.people)}`));

  section('MOVED — NOT SPENT', day
    .filter((e) => e.kind === 'transfer')
    .map((e) => `${name(e.accountId, book.accounts)} → ${name(e.toAccountId, book.accounts)}: ${money(e.amount)}`));

  const outstanding: string[] = [];
  for (const l of book.loans) {
    const v = loanBalance(book, l, date);
    if (!v) continue;
    const from = name(v >= 0 ? l.fromBusiness : l.toBusiness, book.businesses);
    const to = name(v >= 0 ? l.toBusiness : l.fromBusiness, book.businesses);
    outstanding.push(`${from} → ${to}: ${money(Math.abs(v))}`);
  }
  for (const p of book.people) {
    const v = personBalance(book, p.id, date);
    if (v) outstanding.push(`${p.name}: ${money(v)} (${v < 0 ? 'you owe' : 'owes you'})`);
  }
  section('OUTSTANDING', outstanding);

  section('REMINDERS', book.reminders.map((r) => `${r.what}: ${money(r.amount)}`));

  if (day.length === 0) out.push('Nothing was entered on this day.', '');
  return out.join('\n');
}

/** A one-line version, for a notification that has to fit on a lock screen. */
export function dayHeadline(book: Book, date: string): string {
  const day = ordered(book.entries).filter((e) => e.occurredOn === date);
  const spent = day.filter((e) => !e.historical && ['expense', 'salary', 'person_loan', 'supplier_payment'].includes(e.kind))
    .reduce((s, e) => s + e.amount, 0);
  const received = day.filter((e) => e.kind === 'receipt' && !e.historical).reduce((s, e) => s + e.amount, 0);
  return `Cash ${money(totalCash(book, date))} · in ${money(received)} · out ${money(spent)} · ${day.length} entries`;
}

function longDate(iso: string): string {
  const dt = new Date(`${iso}T12:00:00Z`);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  return `${days[dt.getUTCDay()]} ${dt.getUTCDate()} ${months[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

export { accountBalance };

/**
 * Getting the book out — as a spreadsheet for whoever asks, and as a whole
 * backup you can keep. Both are read-only views of what is already there.
 */
import type { Book, Entry } from '../shared/types.js';

const KIND: Record<string, string> = {
  expense: 'Expense', credit_purchase: 'On credit', receipt: 'Receipt', transfer: 'Transfer',
  person_loan: 'Loan out', salary: 'Salary', supplier_payment: 'Supplier paid',
};

/** A cell that cannot break the row it sits in, whatever was typed into it. */
function cell(value: unknown): string {
  const s = value == null ? '' : String(value);
  // a leading =, +, - or @ makes a spreadsheet treat text as a formula
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function entriesCsv(book: Book): string {
  const name = (id: string | null | undefined, list: { id: string; name: string }[]) =>
    list.find((x) => x.id === id)?.name ?? '';

  const head = ['Date', 'Type', 'Purpose', 'Amount', 'Account', 'Into', 'Business',
    'On behalf of', 'Project', 'Person', 'Historical', 'Voided', 'Corrected from', 'Entered', 'What was typed'];

  const rows = [...book.entries]
    .sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : 0))
    .map((e: Entry) => {
      const account = book.accounts.find((a) => a.id === e.accountId);
      return [
        e.occurredOn, KIND[e.kind] ?? e.kind, e.purpose, e.amount,
        account?.name ?? '', name(e.toAccountId, book.accounts),
        book.businesses.find((b) => b.id === account?.businessId)?.name ?? '',
        name(e.forBusiness, book.businesses), name(e.projectId, book.projects), name(e.personId, book.people),
        e.historical ? 'yes' : '', e.voided ? 'yes' : '', e.correctedFrom ?? '',
        e.createdAt.slice(0, 19).replace('T', ' '), e.raw,
      ].map(cell).join(',');
    });

  return [head.map(cell).join(','), ...rows].join('\n');
}

/** Everything, exactly as stored, so a book can be rebuilt from it. */
export function backup(book: Book): string {
  return JSON.stringify({ takenAt: new Date().toISOString(), version: 1, book }, null, 2);
}

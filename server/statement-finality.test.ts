import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('statement correction and void finality', () => {
  it('locks the correction action after the first successful correction', () => {
    const statement = read('client/src/views/Statement.tsx');
    const book = read('server/book.ts');

    expect(statement).toContain('r.entry.correctedAt != null || r.entry.correctedFrom != null');
    expect(statement).toContain('This entry is locked after its correction');
    expect(statement).toContain('Corrected — this entry is now locked.');
    expect(book).toContain('before.entry.corrected_at || before.entry.corrected_from != null');
    expect(book).toContain('This entry was already corrected and is now locked.');
  });

  it('makes void a full accounting reversal while preserving audit history', () => {
    const book = read('server/book.ts');
    const performance = read('server/performance.ts');
    const voidBody = book.slice(book.indexOf('export async function voidEntry'));

    expect(voidBody).toContain('await supersedeEffects(client, entryId');
    expect(voidBody).toContain("UPDATE project_receipts SET in_cash = false");
    expect(voidBody).toContain("UPDATE pending_transfers SET status = 'voided'");
    expect(voidBody).toContain("writeEntryRevision(client, entryId, transactionId, 'void'");
    expect(voidBody).not.toContain('DELETE FROM entries');
    expect(performance).toContain('WHERE e.voided = false');
  });

  it('has a migration for the historical voided handoff state', () => {
    const migration = read('server/migrations/007_voided_handoffs.sql');
    expect(migration).toContain("'pending','confirmed','rejected','voided'");
    expect(migration).toContain('pending_transfers_status_check');
  });
});

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
    expect(voidBody).toContain("writeEntryRevision(client, entryId, transactionId, 'void'");
    expect(voidBody).not.toContain('DELETE FROM entries');
    expect(performance).toContain('WHERE e.voided = false');
  });

  it('keeps a confirmed handoff as history but rejects any active effects after its ledger entry is voided', () => {
    const integrity = read('server/integrity.ts');
    expect(integrity).toContain("'voided_transfer_still_active'");
    expect(integrity).toContain('e.voided = true');
    expect(integrity).toContain('ef.active = true');
    expect(integrity).not.toContain("pt.entry_id IS NULL OR e.id IS NULL OR e.voided = true OR e.kind <> 'transfer'");
  });
});

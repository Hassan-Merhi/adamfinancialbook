import { loadBook } from './book.js';
import { query } from './db.js';
import { withLoanEffects } from '../shared/engine.js';
import type { Effect, Entry } from '../shared/types.js';

export interface IntegrityIssue {
  code: string;
  severity: 'error' | 'warning';
  subject: string | null;
  message: string;
}

export interface IntegrityResult {
  ok: boolean;
  checkedAt: string;
  issueCount: number;
  errors: number;
  warnings: number;
  issues: IntegrityIssue[];
}

const KNOWN_KINDS = new Set([
  'expense', 'credit_purchase', 'receipt', 'transfer', 'person_loan', 'salary', 'supplier_payment',
]);

function issue(
  issues: IntegrityIssue[],
  code: string,
  message: string,
  subject: string | null = null,
  severity: 'error' | 'warning' = 'error',
): void {
  issues.push({ code, severity, subject, message });
}

function normalizedEffect(effect: Effect) {
  return {
    type: effect.type,
    targetId: effect.targetId ?? null,
    fromBusiness: effect.fromBusiness ?? null,
    toBusiness: effect.toBusiness ?? null,
    delta: Math.round(Number(effect.delta) * 100) / 100,
  };
}

export function effectsMatch(expected: Effect[], actual: Effect[]): boolean {
  const canonical = (effects: Effect[]) => effects
    .map(normalizedEffect)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify(canonical(expected)) === JSON.stringify(canonical(actual));
}

export function findComputedEffectIssues(entries: Entry[], catalog: Awaited<ReturnType<typeof loadBook>>): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  for (const entry of entries) {
    if (entry.voided) continue;
    const expected = withLoanEffects(entry, catalog);
    if (!effectsMatch(expected, entry.effects)) {
      issue(
        issues,
        'effect_mismatch',
        'Stored active effects do not match the effects implied by this entry.',
        entry.id,
      );
    }
  }
  return issues;
}

export async function runIntegrityCheck(): Promise<IntegrityResult> {
  const issues: IntegrityIssue[] = [];

  const badEntries = await query<{
    id: string;
    kind: string;
    amount: number;
    account_id: string | null;
    to_account_id: string | null;
  }>(
    `SELECT id, kind, amount, account_id, to_account_id
       FROM entries
      WHERE amount <= 0
         OR kind NOT IN ('expense','credit_purchase','receipt','transfer','person_loan','salary','supplier_payment')
         OR (kind = 'transfer' AND (account_id IS NULL OR to_account_id IS NULL OR account_id = to_account_id))`,
  );
  for (const row of badEntries) {
    if (Number(row.amount) <= 0) issue(issues, 'entry_amount_invalid', 'Entry amount is not positive.', row.id);
    if (!KNOWN_KINDS.has(row.kind)) issue(issues, 'entry_kind_unknown', `Unknown entry kind: ${row.kind}.`, row.id);
    if (row.kind === 'transfer' && (!row.account_id || !row.to_account_id || row.account_id === row.to_account_id)) {
      issue(issues, 'transfer_shape_invalid', 'Transfer does not have two different accounts.', row.id);
    }
  }

  const duplicateRefs = await query<{ client_ref: string; n: number }>(
    `SELECT client_ref, count(*)::int AS n
       FROM entries
      WHERE client_ref IS NOT NULL
      GROUP BY client_ref HAVING count(*) > 1`,
  );
  for (const row of duplicateRefs) {
    issue(issues, 'duplicate_client_ref', `Client reference is used by ${row.n} entries.`, row.client_ref);
  }

  const duplicateTransactions = await query<{ transaction_id: string; n: number }>(
    `SELECT transaction_id, count(*)::int AS n
       FROM entries
      GROUP BY transaction_id HAVING count(*) > 1`,
  );
  for (const row of duplicateTransactions) {
    issue(issues, 'duplicate_transaction_id', `Transaction id is used by ${row.n} entries.`, row.transaction_id);
  }

  const orphanReceipts = await query<{ id: string; entry_id: string }>(
    `SELECT pr.id, pr.entry_id
       FROM project_receipts pr
       LEFT JOIN entries e ON e.id = pr.entry_id
      WHERE pr.entry_id IS NOT NULL AND e.id IS NULL`,
  );
  for (const row of orphanReceipts) {
    issue(issues, 'orphan_project_receipt', `Project receipt points to missing entry ${row.entry_id}.`, row.id);
  }

  const invalidEffects = await query<{ id: string; entry_id: string; type: string }>(
    `SELECT e.id::text, e.entry_id, e.type
       FROM effects e
       LEFT JOIN accounts a ON e.type = 'account' AND a.id = e.target_id
       LEFT JOIN projects p ON e.type IN ('project','cost') AND p.id = e.target_id
       LEFT JOIN people pe ON e.type = 'person' AND pe.id = e.target_id
       LEFT JOIN project_receipts pr ON e.type = 'receipt_banked' AND pr.id = e.target_id AND pr.voided_at IS NULL
       LEFT JOIN businesses bf ON e.type = 'loan' AND bf.id = e.from_business
       LEFT JOIN businesses bt ON e.type = 'loan' AND bt.id = e.to_business
      WHERE e.active = true
        AND (
          (e.type = 'account' AND a.id IS NULL)
          OR (e.type IN ('project','cost') AND p.id IS NULL)
          OR (e.type = 'person' AND pe.id IS NULL)
          OR (e.type = 'receipt_banked' AND pr.id IS NULL)
          OR (e.type = 'loan' AND (bf.id IS NULL OR bt.id IS NULL OR bf.id = bt.id))
          OR e.type NOT IN ('account','project','person','loan','cost','receipt_banked')
        )`,
  );
  for (const row of invalidEffects) {
    issue(issues, 'effect_target_invalid', `Active ${row.type} effect points to a missing or invalid target.`, row.entry_id);
  }

  const badSuperseded = await query<{ id: string; entry_id: string }>(
    `SELECT id::text, entry_id FROM effects
      WHERE active = false AND superseded_at IS NULL`,
  );
  for (const row of badSuperseded) {
    issue(issues, 'effect_history_incomplete', 'Superseded effect has no superseded timestamp.', row.entry_id);
  }

  const brokenConfirmed = await query<{
    id: string;
    entry_id: string | null;
  }>(
    `SELECT pt.id, pt.entry_id
       FROM pending_transfers pt
       LEFT JOIN entries e ON e.id = pt.entry_id
      WHERE pt.status = 'confirmed'
        AND (
          pt.entry_id IS NULL OR e.id IS NULL OR e.voided = true OR e.kind <> 'transfer'
          OR e.account_id IS DISTINCT FROM pt.from_account_id
          OR e.to_account_id IS DISTINCT FROM pt.to_account_id
          OR e.amount IS DISTINCT FROM pt.amount
        )`,
  );
  for (const row of brokenConfirmed) {
    issue(issues, 'confirmed_transfer_broken', 'Confirmed delegated transfer is missing its matching live ledger entry.', row.id);
  }

  const pendingWithEntry = await query<{ id: string; entry_id: string }>(
    `SELECT id, entry_id FROM pending_transfers
      WHERE status = 'pending' AND entry_id IS NOT NULL`,
  );
  for (const row of pendingWithEntry) {
    issue(issues, 'pending_transfer_already_posted', `Pending transfer already points to entry ${row.entry_id}.`, row.id);
  }

  const reverseLoanDuplicates = await query<{ pair: string; n: number }>(
    `SELECT least(from_business, to_business) || ':' || greatest(from_business, to_business) AS pair,
            count(*)::int AS n
       FROM loans
      GROUP BY least(from_business, to_business), greatest(from_business, to_business)
     HAVING count(*) > 1`,
  );
  for (const row of reverseLoanDuplicates) {
    issue(issues, 'duplicate_loan_pair', `Business pair has ${row.n} loan-position rows.`, row.pair);
  }

  const book = await loadBook();
  issues.push(...findComputedEffectIssues(book.entries, book));

  const errors = issues.filter((item) => item.severity === 'error').length;
  const warnings = issues.length - errors;
  return {
    ok: errors === 0,
    checkedAt: new Date().toISOString(),
    issueCount: issues.length,
    errors,
    warnings,
    issues,
  };
}

export function startIntegrityMonitor(): void {
  if (process.env.NODE_ENV === 'test') return;
  const run = async () => {
    try {
      const result = await runIntegrityCheck();
      const payload = {
        event: result.ok ? 'accounting.integrity.ok' : 'accounting.integrity.failed',
        checkedAt: result.checkedAt,
        errors: result.errors,
        warnings: result.warnings,
        issues: result.ok ? undefined : result.issues.slice(0, 50),
      };
      (result.ok ? console.log : console.error)(JSON.stringify(payload));
    } catch (error) {
      console.error(JSON.stringify({
        event: 'accounting.integrity.error',
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const first = setTimeout(run, 60_000);
  first.unref();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref();
}

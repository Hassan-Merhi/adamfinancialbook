import type { Effect, EntryInput, EntryKind, PersonKind } from './types';

export type OfflineConflictKind =
  | 'stale_balance'
  | 'insufficient_funds'
  | 'target_missing'
  | 'target_changed'
  | 'entry_changed'
  | 'permission_changed'
  | 'receipt_changed'
  | 'idempotency_key_reused';

export interface OfflineAccountExpectation {
  id: string;
  businessId: string | null;
  balance: number;
}

export interface OfflineProjectExpectation {
  id: string;
  businessId: string;
}

export interface OfflinePersonExpectation {
  id: string;
  businessId: string;
  kind: PersonKind;
}

export interface OfflineReceiptExpectation {
  id: string;
  projectId: string;
  amount: number;
  inCash: boolean;
}

/**
 * The exact server-confirmed/projected facts a person relied on when creating
 * one offline financial instruction. Later queued instructions capture the
 * projected balance after earlier queued work, so sequential replay does not
 * falsely look stale when those earlier rows post first.
 */
export interface OfflineSyncContext {
  version: 1;
  capturedAt: string;
  sourceAccount: OfflineAccountExpectation | null;
  destinationAccount: OfflineAccountExpectation | null;
  project: OfflineProjectExpectation | null;
  person: OfflinePersonExpectation | null;
  receipt: OfflineReceiptExpectation | null;
}

export type OfflineEntryInput = EntryInput & { offlineContext?: OfflineSyncContext | null };

/**
 * Snapshot of the exact ledger row a queued correction/void was based on.
 * The active-effect signature makes a revision conflict-safe even if a future
 * server-side classification changes accounting without changing the amount.
 */
export interface OfflineRevisionExpectation {
  id: string;
  occurredOn: string;
  kind: EntryKind;
  amount: number;
  purpose: string;
  raw: string;
  accountId: string | null;
  toAccountId: string | null;
  projectId: string | null;
  personId: string | null;
  forBusiness: string | null;
  historical: boolean;
  linkReceiptId: string | null;
  correctedFrom: number | null;
  correctedAt: string | null;
  voided: boolean;
  voidedAt: string | null;
  effectSignature: string;
}

export interface OfflineRevisionContext {
  version: 1;
  capturedAt: string;
  entry: OfflineRevisionExpectation;
}

export interface OfflineCorrectionInput {
  offlineOperation: 'correct';
  entryId: string;
  amount: number;
  clientRef?: string | null;
  offlineContext: OfflineRevisionContext;
}

export interface OfflineVoidInput {
  offlineOperation: 'void';
  entryId: string;
  reason: string;
  clientRef?: string | null;
  offlineContext: OfflineRevisionContext;
}

export type OfflineRevisionInput = OfflineCorrectionInput | OfflineVoidInput;
export type OfflineQueueInput = OfflineEntryInput | OfflineRevisionInput;

export function isOfflineRevisionInput(value: unknown): value is OfflineRevisionInput {
  if (!value || typeof value !== 'object') return false;
  const operation = (value as { offlineOperation?: unknown }).offlineOperation;
  return operation === 'correct' || operation === 'void';
}

export function isOfflineCorrectionInput(value: unknown): value is OfflineCorrectionInput {
  return isOfflineRevisionInput(value) && value.offlineOperation === 'correct';
}

export function isOfflineVoidInput(value: unknown): value is OfflineVoidInput {
  return isOfflineRevisionInput(value) && value.offlineOperation === 'void';
}

/** Stable active-effect representation shared by browser tests and server checks. */
export function offlineEffectSignature(effects: Effect[]): string {
  return effects
    .map((effect) => [
      effect.type,
      effect.targetId ?? '',
      effect.fromBusiness ?? '',
      effect.toBusiness ?? '',
      Number(effect.delta).toFixed(2),
    ].join('|'))
    .sort()
    .join(';');
}

export interface OfflineConflictInfo {
  kind: OfflineConflictKind;
  message: string;
  targetId: string | null;
  expected: unknown;
  current: unknown;
  detectedAt: string;
}

export interface OfflineConflictResponse {
  error: string;
  code: 'OFFLINE_CONFLICT';
  details: OfflineConflictInfo;
}

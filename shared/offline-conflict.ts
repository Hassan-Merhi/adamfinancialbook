import type { EntryInput, PersonKind } from './types';

export type OfflineConflictKind =
  | 'stale_balance'
  | 'insufficient_funds'
  | 'target_missing'
  | 'target_changed'
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

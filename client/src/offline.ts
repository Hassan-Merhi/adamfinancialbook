import { ApiError, NotSignedIn, type LoadedBook } from './api';
import type { Entry, EntryInput } from '../../shared/types';
import type {
  OfflineConflictInfo,
  OfflineConflictKind,
  OfflineCorrectionInput,
  OfflineEntryInput,
  OfflineRevisionInput,
  OfflineVoidInput,
} from '../../shared/offline-conflict';
import { isOfflineRevisionInput } from '../../shared/offline-conflict';
import { isOfflineSetupInput, offlineSetupEntityId, offlineSetupParentEntityId, type OfflineSetupDraft, type OfflineSetupInput } from '../../shared/offline-setup';
import { orderQueuedByDependencies, queuedDependents } from './offline-dependencies';
import { offlineRepository, type OfflineUser, type Queued } from './offline-db';
import { captureOfflineContext, captureOfflineRevisionContext } from './offline-conflict';
import { projectOfflineBook } from './offline-projection';
import { sendOfflineQueued } from './offline-revision-api';
import {
  offlineSyncState,
  type SyncErrorInfo,
  type SyncItemState,
  type SyncSummary,
} from './offline-sync-state';

export type { Queued } from './offline-db';
export type { SyncErrorInfo, SyncItemState, SyncSummary } from './offline-sync-state';
export type { OfflineSetupDraft, OfflineSetupInput } from '../../shared/offline-setup';
export { sendOfflineQueued };

export const OFFLINE_AUTO_SYNC_EVENT = 'book:offline-auto-sync-result';
export interface OfflineAutoSyncResult {
  sent: number;
  error: string | null;
}

/**
 * Durable storage + projected-book facade + Phase 3/4 sync state machine.
 *
 * The last server-confirmed snapshot is immutable. Unsynced financial writes
 * stay in the per-user outbox and get durable state from Phase 1's reserved
 * syncMeta store. A server acknowledgement removes an outbox row; no failure
 * path silently drops financial work. Corrections and voids use the same strict
 * queue order as new entries so later offline work sees their projected effect.
 */
let syncActivation: Promise<void> = Promise.resolve();

export async function initializeOfflineStorage(): Promise<void> {
  await offlineRepository.initialize();
  const user = offlineRepository.getActiveUser<OfflineUser>();
  syncActivation = (async () => {
    if (user?.id) {
      await offlineSyncState.activate(user.id);
      await offlineSyncState.recoverInterrupted(offlineRepository.queueAll());
    } else {
      offlineSyncState.deactivate();
    }
  })();
  await syncActivation;
}

export async function resetOfflineStorageForTests(): Promise<void> {
  cancelRetryTimer();
  await syncActivation.catch(() => undefined);
  await offlineSyncState.resetForTests();
  await offlineRepository.resetForTests();
  syncActivation = Promise.resolve();
  flushing = null;
}

export const snapshot = {
  save: (book: unknown) => offlineRepository.saveSnapshot(book),
  load: <T>(): T | null => {
    const confirmed = offlineRepository.loadSnapshot<T>();
    if (!confirmed || !looksLikeLoadedBook(confirmed)) return confirmed;
    return projectOfflineBook(confirmed, offlineRepository.queueAll()) as T;
  },
  /** Useful for tests/diagnostics that must prove queued writes never rewrite the server snapshot. */
  loadConfirmed: <T>(): T | null => offlineRepository.loadSnapshot<T>(),
};

function looksLikeLoadedBook(value: unknown): value is LoadedBook {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LoadedBook>;
  return Array.isArray(candidate.accounts)
    && Array.isArray(candidate.entries)
    && !!candidate.balances
    && typeof candidate.balances === 'object'
    && typeof candidate.balances.totalCash === 'number';
}

export const lastUser = {
  save: async <T extends OfflineUser>(user: T | null): Promise<void> => {
    if (!user) return;
    const profileWrite = offlineRepository.setActiveUser(user);
    syncActivation = (async () => {
      await Promise.all([profileWrite, offlineSyncState.activate(user.id)]);
      const queue = offlineRepository.queueAll();
      await offlineSyncState.recoverInterrupted(queue);
      await offlineSyncState.resumeAfterAuthentication(queue);
    })();
    await syncActivation;
  },
  load: <T>(): T | null => offlineRepository.getActiveUser<T>(),
  clear: (): Promise<void> => {
    offlineSyncState.deactivate();
    syncActivation = Promise.resolve();
    cancelRetryTimer();
    return offlineRepository.clearSession();
  },
};

function revisedClientRef(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return `q_review_${random}`;
}

function revisionFromQueued(item: Queued): OfflineRevisionInput | null {
  return isOfflineRevisionInput(item.input) ? item.input : null;
}

function ensureRevisionCanQueue(entry: Entry, operation: 'correct' | 'void'): void {
  if (entry.id.startsWith('offline:')) {
    throw new Error('This entry has not reached the server yet. Let it sync before correcting or voiding it.');
  }
  if (entry.voided) throw new Error('This entry is already void.');
  if (entry.offlinePendingRevision) {
    throw new Error(`This entry already has a ${entry.offlinePendingRevision} waiting to sync.`);
  }
  const alreadyWaiting = offlineRepository.queueAll().some((item) => revisionFromQueued(item)?.entryId === entry.id);
  if (alreadyWaiting) throw new Error('This entry already has an offline correction or void waiting to sync.');
  if (operation === 'correct' && (entry.correctedAt != null || entry.correctedFrom != null)) {
    throw new Error('This entry was already corrected and is locked. Void it if it is still wrong.');
  }
}

function confirmedSetupParent(draft: OfflineSetupDraft, confirmed: LoadedBook, parentId: string): boolean {
  if (draft.setupType === 'account' || draft.setupType === 'project' || draft.setupType === 'person') {
    return confirmed.businesses.some((item) => item.id === parentId);
  }
  if (draft.setupType === 'reminder') return confirmed.accounts.some((item) => item.id === parentId);
  return true;
}

function setupDependencies(draft: OfflineSetupDraft, confirmed: LoadedBook): string[] {
  const parentId = offlineSetupParentEntityId(draft);
  if (!parentId || confirmedSetupParent(draft, confirmed, parentId)) return [];

  const pending = offlineSyncState.effective(offlineRepository.queueAll());
  const parent = pending.find((item) => {
    if (!isOfflineSetupInput(item.input as unknown)) return false;
    const setup = item.input as unknown as OfflineSetupInput;
    if (offlineSetupEntityId(setup) !== parentId) return false;
    if (draft.setupType === 'reminder') return setup.setupType === 'account';
    return setup.setupType === 'business';
  });
  if (!parent) throw new Error('That setup item points to a parent that is not available offline. Reload once online or choose an existing queued parent.');

  const state = offlineSyncState.stateFor(parent.id);
  if (state.status === 'conflict' || state.status === 'rejected') {
    throw new Error('That parent setup change needs review before you can add more offline changes under it.');
  }
  return [parent.id];
}

async function queueSetup(draft: OfflineSetupDraft): Promise<Queued> {
  await syncActivation;
  const confirmed = snapshot.loadConfirmed<LoadedBook>();
  if (!confirmed) throw new Error('Load the book once online before changing setup offline.');
  const offlineDependsOn = setupDependencies(draft, confirmed);
  const prepared = { ...draft, offlineOperation: 'setup_create', offlineDependsOn } as OfflineSetupInput;
  const item = await offlineRepository.queueAdd(prepared as unknown as EntryInput);
  await offlineSyncState.registerQueued(item.id);
  return offlineSyncState.effective([item])[0] ?? item;
}

async function queueRevision(input: OfflineRevisionInput): Promise<Queued> {
  // Phase 1's durable outbox predates revision payloads and its persistence row
  // intentionally remains shape-agnostic. The discriminated payload is stored
  // in the same `input` slot so ordering/retry/auth/conflict guarantees are shared.
  const item = await offlineRepository.queueAdd(input as unknown as EntryInput);
  await offlineSyncState.registerQueued(item.id);
  return item;
}

export const outbox = {
  /** Every durable financial write still waiting for a server acknowledgement. */
  all: (): Queued[] => offlineRepository.queueAll(),
  records: (): Queued[] => offlineSyncState.effective(offlineRepository.queueAll()),
  add: async (input: EntryInput): Promise<Queued> => {
    await syncActivation;
    const projected = snapshot.load<LoadedBook>();
    const prepared: OfflineEntryInput = projected
      ? { ...input, offlineContext: captureOfflineContext(projected, input) }
      : { ...input };
    const item = await offlineRepository.queueAdd(prepared as EntryInput);
    await offlineSyncState.registerQueued(item.id);
    return offlineSyncState.effective([item])[0] ?? item;
  },
  setup: (draft: OfflineSetupDraft): Promise<Queued> => queueSetup(draft),
  setupPending: () => offlineSyncState.effective(offlineRepository.queueAll())
    .filter((item) => isOfflineSetupInput(item.input as unknown))
    .map((item) => ({
      item,
      input: item.input as unknown as OfflineSetupInput,
      entityId: offlineSetupEntityId(item.input as unknown as OfflineSetupInput),
    })),
  correct: async (entry: Entry, amount: number): Promise<Queued> => {
    await syncActivation;
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter an amount greater than zero.');
    ensureRevisionCanQueue(entry, 'correct');
    const prepared: OfflineCorrectionInput = {
      offlineOperation: 'correct',
      entryId: entry.id,
      amount,
      offlineContext: captureOfflineRevisionContext(entry),
    };
    return queueRevision(prepared);
  },
  void: async (entry: Entry, reason: string): Promise<Queued> => {
    await syncActivation;
    const why = reason.trim();
    if (!why) throw new Error('Say why this entry is being voided.');
    if (why.length > 200) throw new Error('Keep the void reason under 200 characters.');
    ensureRevisionCanQueue(entry, 'void');
    const prepared: OfflineVoidInput = {
      offlineOperation: 'void',
      entryId: entry.id,
      reason: why,
      offlineContext: captureOfflineRevisionContext(entry),
    };
    return queueRevision(prepared);
  },
  drop: async (id: string): Promise<void> => {
    const dependents = queuedDependents(offlineRepository.queueAll(), id);
    if (dependents.length) {
      throw new Error(`This queued setup change still has ${dependents.length} dependent ${dependents.length === 1 ? 'change' : 'changes'}. Discard the dependent change first.`);
    }
    await offlineRepository.queueDrop(id);
    await offlineSyncState.remove(id);
  },
  clear: async (): Promise<void> => {
    const ids = offlineRepository.queueAll().map((item) => item.id);
    await offlineRepository.queueClear();
    await offlineSyncState.clearQueueState(ids);
  },
  retry: (id: string): Promise<void> => offlineSyncState.retry(id),
  status: (id: string): SyncItemState => offlineSyncState.stateFor(id),
  summary: (): SyncSummary => offlineSyncState.summary(offlineRepository.queueAll()),
  conflicts: () => offlineSyncState.conflictRows(offlineRepository.queueAll()),
  /**
   * Re-review one conflicted ordinary entry against a freshly loaded server
   * book. Revisions deliberately cannot be rebased blindly: if the original
   * server row changed, the owner must inspect that new row before deciding on
   * another correction/void.
   */
  rebase: async (
    id: string,
    book: LoadedBook,
    patch: Partial<Pick<EntryInput, 'amount' | 'purpose' | 'raw'>> = {},
  ): Promise<void> => {
    const item = offlineSyncState.effective(offlineRepository.queueAll()).find((candidate) => candidate.id === id);
    if (!item) throw new Error('That queued entry is no longer waiting.');
    if (isOfflineRevisionInput(item.input)) {
      throw new Error('A correction or void cannot be automatically rebased. Review the latest server entry and decide again.');
    }
    if (isOfflineSetupInput(item.input as unknown)) {
      throw new Error('A setup creation cannot be automatically rewritten. Retry it unchanged or discard it after review.');
    }
    const state = offlineSyncState.stateFor(id);
    const current = item.input as OfflineEntryInput;
    const clientRef = state.conflict?.kind === 'idempotency_key_reused'
      ? revisedClientRef()
      : current.clientRef ?? item.id;
    const revised: OfflineEntryInput = {
      ...current,
      ...patch,
      clientRef,
    };
    revised.offlineContext = captureOfflineContext(book, revised);
    await offlineSyncState.rebase(id, revised);
  },
  whenIdle: async (): Promise<void> => {
    await Promise.all([offlineRepository.whenIdle(), offlineSyncState.whenIdle()]);
  },
};

/** True when the browser says there is no network — treat fetch TypeError as unreachable too. */
export function looksOffline(err: unknown): boolean {
  const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return browserOffline || err instanceof TypeError;
}

export type SyncBlockReason = 'rejected' | 'auth' | 'conflict';

export class SyncBlockedError extends Error {
  reason: SyncBlockReason;
  itemId: string;
  constructor(reason: SyncBlockReason, itemId: string, message: string) {
    super(message);
    this.reason = reason;
    this.itemId = itemId;
  }
}

export interface FlushOptions {
  now?: () => number;
  schedule?: boolean;
}

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAtMs: number | null = null;

function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempts - 1, 8)));
}

function cancelRetryTimer(): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  retryAtMs = null;
}

function emitAutoSyncResult(detail: OfflineAutoSyncResult): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent<OfflineAutoSyncResult>(OFFLINE_AUTO_SYNC_EVENT, { detail }));
}

function scheduleRetry(
  send: (input: EntryInput) => Promise<unknown>,
  at: string,
  options: FlushOptions,
): void {
  if (options.schedule === false || typeof setTimeout === 'undefined') return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const target = Date.parse(at);
  if (!Number.isFinite(target)) return;
  if (retryTimer !== null && retryAtMs !== null && retryAtMs <= target) return;
  cancelRetryTimer();
  retryAtMs = target;
  const now = options.now?.() ?? Date.now();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryAtMs = null;
    void flushOutbox(send, options)
      .then((sent) => emitAutoSyncResult({ sent, error: null }))
      .catch((error) => emitAutoSyncResult({ sent: 0, error: error instanceof Error ? error.message : String(error) }));
  }, Math.max(0, target - now));
}

function conflictKind(err: ApiError): OfflineConflictKind | null {
  const prefix = 'OFFLINE_CONFLICT_';
  if (err.status !== 409 || !err.code?.startsWith(prefix)) return null;
  const value = err.code.slice(prefix.length).toLowerCase();
  const known: OfflineConflictKind[] = [
    'stale_balance',
    'insufficient_funds',
    'target_missing',
    'target_changed',
    'entry_changed',
    'permission_changed',
    'receipt_changed',
    'idempotency_key_reused',
  ];
  return known.includes(value as OfflineConflictKind) ? value as OfflineConflictKind : null;
}

function errorInfo(err: unknown, at: string): SyncErrorInfo {
  if (err instanceof NotSignedIn) {
    return { kind: 'auth', message: err.message, status: 401, code: null, at };
  }
  if (looksOffline(err)) {
    return {
      kind: 'network',
      message: err instanceof Error ? err.message : 'The server could not be reached.',
      status: null,
      code: null,
      at,
    };
  }
  if (err instanceof ApiError) {
    return {
      kind: conflictKind(err) ? 'conflict' : 'server',
      message: err.message,
      status: err.status,
      code: err.code ?? null,
      at,
    };
  }
  return {
    kind: 'server',
    message: err instanceof Error ? err.message : 'The sync attempt failed.',
    status: null,
    code: null,
    at,
  };
}

function retryable(err: unknown): boolean {
  if (looksOffline(err)) return true;
  if (!(err instanceof ApiError)) return false;
  return err.status === 408 || err.status === 425 || err.status === 429 || err.status >= 500;
}

let flushing: Promise<number> | null = null;

export async function flushOutbox(
  send: (input: EntryInput) => Promise<unknown>,
  options: FlushOptions = {},
): Promise<number> {
  if (flushing) return flushing;
  flushing = runFlush(send, options).finally(() => { flushing = null; });
  return flushing;
}

async function runFlush(
  send: (input: EntryInput) => Promise<unknown>,
  options: FlushOptions,
): Promise<number> {
  await syncActivation;
  const rawQueue = orderQueuedByDependencies(offlineSyncState.effective(offlineRepository.queueAll()));
  if (!rawQueue.length) {
    cancelRetryTimer();
    return 0;
  }

  const nowMs = options.now ?? Date.now;
  const runAt = new Date(nowMs()).toISOString();
  await offlineSyncState.noteRun(runAt);
  let sent = 0;

  for (const item of rawQueue) {
    let state = offlineSyncState.stateFor(item.id);

    if (state.status === 'conflict') {
      throw new SyncBlockedError(
        'conflict',
        item.id,
        state.conflict?.message || 'This queued change conflicts with newer server data and needs review.',
      );
    }
    if (state.status === 'rejected') {
      throw new SyncBlockedError(
        'rejected',
        item.id,
        state.lastError?.message || 'A queued change was rejected by the server and needs review before later changes can sync.',
      );
    }
    if (state.status === 'blocked_auth') {
      throw new SyncBlockedError(
        'auth',
        item.id,
        state.lastError?.message || 'Sign in again before this queued change can sync.',
      );
    }

    if (state.status === 'retry_wait' && state.nextAttemptAt) {
      const due = Date.parse(state.nextAttemptAt);
      if (Number.isFinite(due) && due > nowMs()) {
        scheduleRetry(send, state.nextAttemptAt, options);
        break;
      }
    }

    const attemptAt = new Date(nowMs()).toISOString();
    state = await offlineSyncState.updateItem(item.id, {
      status: 'syncing',
      attempts: state.attempts + 1,
      lastAttemptAt: attemptAt,
      nextAttemptAt: null,
      lastError: null,
      conflict: null,
    });

    try {
      await (isOfflineRevisionInput(item.input) || isOfflineSetupInput(item.input as unknown)
        ? sendOfflineQueued(item.input as unknown as EntryInput)
        : send(item.input));
      await offlineRepository.queueDrop(item.id);
      await offlineSyncState.remove(item.id);
      const successAt = new Date(nowMs()).toISOString();
      await offlineSyncState.noteSuccess(successAt);
      sent += 1;
    } catch (err) {
      const failedAt = new Date(nowMs()).toISOString();
      const info = errorInfo(err, failedAt);
      await offlineSyncState.noteError(info);

      if (err instanceof NotSignedIn) {
        await offlineSyncState.updateItem(item.id, {
          status: 'blocked_auth',
          nextAttemptAt: null,
          lastError: info,
        });
        throw new SyncBlockedError('auth', item.id, 'Your session expired. Sign in again; the queued entry is still safely stored.');
      }

      if (err instanceof ApiError) {
        const kind = conflictKind(err);
        if (kind) {
          const revision = revisionFromQueued(item);
          const setup = isOfflineSetupInput(item.input as unknown) ? item.input as unknown as OfflineSetupInput : null;
          const input = item.input as OfflineEntryInput;
          const targetId = setup ? offlineSetupEntityId(setup) : revision?.entryId
            ?? input.accountId ?? input.toAccountId ?? input.projectId ?? input.personId ?? input.linkReceiptId ?? null;
          const detail: OfflineConflictInfo = {
            kind,
            message: err.message,
            targetId,
            expected: revision?.offlineContext ?? input.offlineContext ?? null,
            current: null,
            detectedAt: failedAt,
          };
          await offlineSyncState.updateItem(item.id, {
            status: 'conflict',
            nextAttemptAt: null,
            lastError: info,
            conflict: detail,
          });
          throw new SyncBlockedError('conflict', item.id, `${err.message} The change is still stored and later changes are blocked until you review it.`);
        }
      }

      if (retryable(err)) {
        const nextAttemptAt = new Date(nowMs() + retryDelayMs(state.attempts)).toISOString();
        await offlineSyncState.updateItem(item.id, {
          status: 'retry_wait',
          nextAttemptAt,
          lastError: info,
        });
        scheduleRetry(send, nextAttemptAt, options);
        break;
      }

      await offlineSyncState.updateItem(item.id, {
        status: 'rejected',
        nextAttemptAt: null,
        lastError: info,
      });
      const revision = revisionFromQueued(item);
      throw new SyncBlockedError(
        'rejected',
        item.id,
        revision
          ? `The server refused this queued change: ${info.message}. It remains stored and later changes will not overtake it.`
          : isOfflineSetupInput(item.input as unknown)
            ? `The server refused this queued setup change: ${info.message}. It remains stored and later changes will not overtake it.`
            : `The server refused this queued entry: ${info.message}. It remains stored and later entries will not overtake it.`,
      );
    }
  }

  if (!offlineRepository.queueAll().length) cancelRetryTimer();
  return sent;
}

import { ApiError, NotSignedIn, type LoadedBook } from './api';
import type { EntryInput } from '../../shared/types';
import { offlineRepository, type OfflineUser, type Queued } from './offline-db';
import { projectOfflineBook } from './offline-projection';
import {
  offlineSyncState,
  type SyncErrorInfo,
  type SyncItemState,
  type SyncSummary,
} from './offline-sync-state';

export type { Queued } from './offline-db';
export type { SyncErrorInfo, SyncItemState, SyncSummary } from './offline-sync-state';

/**
 * Durable storage + projected-book facade + Phase 3 sync state machine.
 *
 * The last server-confirmed snapshot is immutable.  Unsynced entries stay in
 * the per-user outbox and get their durable state from the already-reserved
 * syncMeta IndexedDB store.  A server acknowledgement removes an outbox row;
 * no failure path silently drops financial work.
 */
export async function initializeOfflineStorage(): Promise<void> {
  await offlineRepository.initialize();
  const user = offlineRepository.getActiveUser<OfflineUser>();
  if (user?.id) {
    await offlineSyncState.activate(user.id);
    await offlineSyncState.recoverInterrupted(offlineRepository.queueAll());
  } else {
    offlineSyncState.deactivate();
  }
}

export async function resetOfflineStorageForTests(): Promise<void> {
  cancelRetryTimer();
  await offlineSyncState.resetForTests();
  await offlineRepository.resetForTests();
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

/**
 * Who was holding the book last time. The repository stores only a global
 * pointer to that user id; the actual profile, snapshot and queued work live in
 * separate user-scoped records.
 */
export const lastUser = {
  save: async <T extends OfflineUser>(user: T | null): Promise<void> => {
    if (!user) return;
    await offlineRepository.setActiveUser(user);
    await offlineSyncState.activate(user.id);
    await offlineSyncState.recoverInterrupted(offlineRepository.queueAll());
  },
  load: <T>(): T | null => offlineRepository.getActiveUser<T>(),
  clear: (): Promise<void> => {
    offlineSyncState.deactivate();
    cancelRetryTimer();
    return offlineRepository.clearSession();
  },
};

export const outbox = {
  /** Entries still eligible to influence the projected book. */
  all: (): Queued[] => offlineSyncState.projectablePrefix(offlineRepository.queueAll()),
  /** All durable rows, including a rejected row and anything blocked behind it. */
  records: (): Queued[] => offlineRepository.queueAll(),
  add: async (input: EntryInput): Promise<Queued> => {
    const item = await offlineRepository.queueAdd(input);
    await offlineSyncState.registerQueued(item.id);
    return item;
  },
  drop: async (id: string): Promise<void> => {
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
  whenIdle: async (): Promise<void> => {
    await Promise.all([offlineRepository.whenIdle(), offlineSyncState.whenIdle()]);
  },
};

/** True when the browser says there is no network — treat fetch TypeError as unreachable too. */
export function looksOffline(err: unknown): boolean {
  const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return browserOffline || err instanceof TypeError;
}

export type SyncBlockReason = 'rejected' | 'auth';

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
    void flushOutbox(send, options).catch(() => {
      // Durable item state already contains the actionable error.  The next
      // reconnect/sign-in/manual retry will resume without losing the item.
    });
  }, Math.max(0, target - now));
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
      kind: 'server',
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

/**
 * Sends durable outbox entries oldest first.  Only a confirmed acknowledgement
 * removes an entry.  Transient failures wait and retry with the same clientRef;
 * auth failures and permanent server refusals remain stored and stop later
 * financial writes from overtaking them.
 */
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
  const rawQueue = offlineRepository.queueAll()
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id));
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

    if (state.status === 'rejected') {
      throw new SyncBlockedError(
        'rejected',
        item.id,
        state.lastError?.message || 'A queued entry was rejected by the server and needs review before later entries can sync.',
      );
    }
    if (state.status === 'blocked_auth') {
      throw new SyncBlockedError(
        'auth',
        item.id,
        state.lastError?.message || 'Sign in again before this queued entry can sync.',
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
    });

    try {
      await send(item.input);
      // Acknowledgement first, durable queue removal second. If the browser dies
      // between them, startup recovery retries the same clientRef safely.
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
      throw new SyncBlockedError(
        'rejected',
        item.id,
        `The server refused this queued entry: ${info.message}. It remains stored and later entries will not overtake it.`,
      );
    }
  }

  if (!offlineRepository.queueAll().length) cancelRetryTimer();
  return sent;
}

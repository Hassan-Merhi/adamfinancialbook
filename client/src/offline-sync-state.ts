import {
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  offlineRepository,
  type Queued,
} from './offline-db';

const SYNC_META_STORE = 'syncMeta';

export type SyncItemStatus = 'pending' | 'syncing' | 'retry_wait' | 'blocked_auth' | 'rejected';
export type SyncErrorKind = 'network' | 'server' | 'auth' | 'interrupted';

export interface SyncErrorInfo {
  kind: SyncErrorKind;
  message: string;
  status: number | null;
  code: string | null;
  at: string;
}

export interface SyncItemState {
  /** Strict durable enqueue order; timestamps alone can tie within one millisecond. */
  order: number;
  status: SyncItemStatus;
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastError: SyncErrorInfo | null;
}

export interface SyncSummary {
  pending: number;
  syncing: number;
  retrying: number;
  blockedAuth: number;
  rejected: number;
  blockedByOrder: number;
  nextRetryAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: SyncErrorInfo | null;
}

interface StoredSyncState {
  version: 1;
  items: Record<string, SyncItemState>;
  nextOrder: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: SyncErrorInfo | null;
}

interface SyncMetaRecord {
  userId: string;
  value: StoredSyncState;
  updatedAt: string;
}

function emptyState(): StoredSyncState {
  return {
    version: 1,
    items: {},
    nextOrder: 1,
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
}

function defaultItemState(order = 0): SyncItemState {
  return {
    order,
    status: 'pending',
    attempts: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    lastError: null,
  };
}

function validStatus(value: unknown): value is SyncItemStatus {
  return value === 'pending'
    || value === 'syncing'
    || value === 'retry_wait'
    || value === 'blocked_auth'
    || value === 'rejected';
}

function normalizeError(value: unknown): SyncErrorInfo | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<SyncErrorInfo>;
  if (!['network', 'server', 'auth', 'interrupted'].includes(String(item.kind))) return null;
  if (typeof item.message !== 'string' || typeof item.at !== 'string') return null;
  return {
    kind: item.kind as SyncErrorKind,
    message: item.message,
    status: typeof item.status === 'number' ? item.status : null,
    code: typeof item.code === 'string' ? item.code : null,
    at: item.at,
  };
}

function normalizeItem(value: unknown): SyncItemState {
  if (!value || typeof value !== 'object') return defaultItemState();
  const item = value as Partial<SyncItemState>;
  return {
    order: Number.isInteger(item.order) && Number(item.order) > 0 ? Number(item.order) : 0,
    status: validStatus(item.status) ? item.status : 'pending',
    attempts: Number.isInteger(item.attempts) && Number(item.attempts) >= 0 ? Number(item.attempts) : 0,
    lastAttemptAt: typeof item.lastAttemptAt === 'string' ? item.lastAttemptAt : null,
    nextAttemptAt: typeof item.nextAttemptAt === 'string' ? item.nextAttemptAt : null,
    lastError: normalizeError(item.lastError),
  };
}

function normalizeState(value: unknown): StoredSyncState {
  if (!value || typeof value !== 'object') return emptyState();
  const candidate = value as Partial<StoredSyncState>;
  const items: Record<string, SyncItemState> = {};
  let maxOrder = 0;
  if (candidate.items && typeof candidate.items === 'object') {
    for (const [id, item] of Object.entries(candidate.items)) {
      items[id] = normalizeItem(item);
      maxOrder = Math.max(maxOrder, items[id].order);
    }
  }
  const requestedNext = Number.isInteger(candidate.nextOrder) && Number(candidate.nextOrder) > 0
    ? Number(candidate.nextOrder)
    : 1;
  return {
    version: 1,
    items,
    nextOrder: Math.max(requestedNext, maxOrder + 1),
    lastRunAt: typeof candidate.lastRunAt === 'string' ? candidate.lastRunAt : null,
    lastSuccessAt: typeof candidate.lastSuccessAt === 'string' ? candidate.lastSuccessAt : null,
    lastError: normalizeError(candidate.lastError),
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Sync metadata request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Sync metadata transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Sync metadata transaction aborted.'));
  });
}

async function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open offline sync metadata.'));
    request.onblocked = () => reject(new Error('Offline sync metadata is blocked by another tab.'));
  });
}

class OfflineSyncState {
  private activeUserId: string | null = null;
  private state: StoredSyncState = emptyState();
  private writeChain: Promise<void> = Promise.resolve();

  async activate(userId: string): Promise<void> {
    if (!userId) {
      this.deactivate();
      return;
    }
    this.activeUserId = userId;
    this.state = emptyState();
    const db = await openDb().catch(() => null);
    if (!db) return;
    try {
      if (!db.objectStoreNames.contains(SYNC_META_STORE)) return;
      const transaction = db.transaction(SYNC_META_STORE, 'readonly');
      const record = await requestResult(transaction.objectStore(SYNC_META_STORE).get(userId)) as SyncMetaRecord | undefined;
      await transactionDone(transaction);
      if (this.activeUserId === userId) this.state = normalizeState(record?.value);
    } finally {
      db.close();
    }
  }

  deactivate(): void {
    this.activeUserId = null;
    this.state = emptyState();
  }

  private persist(): Promise<void> {
    const userId = this.activeUserId;
    if (!userId) return Promise.resolve();
    const value = structuredClone(this.state);
    const work = this.writeChain.then(async () => {
      const db = await openDb();
      if (!db) return;
      try {
        if (!db.objectStoreNames.contains(SYNC_META_STORE)) return;
        const transaction = db.transaction(SYNC_META_STORE, 'readwrite');
        transaction.objectStore(SYNC_META_STORE).put({
          userId,
          value,
          updatedAt: new Date().toISOString(),
        } satisfies SyncMetaRecord);
        await transactionDone(transaction);
      } finally {
        db.close();
      }
    });
    this.writeChain = work.catch((error) => {
      console.error('Could not persist offline sync state.', error);
    });
    return work;
  }

  whenIdle(): Promise<void> {
    return this.writeChain;
  }

  stateFor(id: string): SyncItemState {
    return this.state.items[id] ? structuredClone(this.state.items[id]) : defaultItemState();
  }

  async registerQueued(id: string): Promise<void> {
    if (!this.activeUserId) return;
    const current = this.state.items[id];
    if (!current) {
      this.state.items[id] = defaultItemState(this.state.nextOrder++);
    } else if (current.order <= 0) {
      current.order = this.state.nextOrder++;
    }
    await this.persist();
  }

  async updateItem(id: string, patch: Partial<SyncItemState>): Promise<SyncItemState> {
    const current = this.state.items[id] ?? defaultItemState(this.state.nextOrder++);
    const next: SyncItemState = {
      ...current,
      ...patch,
      lastError: patch.lastError === undefined ? current.lastError : patch.lastError,
    };
    this.state.items[id] = next;
    await this.persist();
    return structuredClone(next);
  }

  async remove(id: string): Promise<void> {
    if (!this.state.items[id]) return;
    delete this.state.items[id];
    await this.persist();
  }

  async clearQueueState(ids: string[]): Promise<void> {
    let changed = false;
    for (const id of ids) {
      if (this.state.items[id]) {
        delete this.state.items[id];
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async retry(id: string): Promise<void> {
    await this.updateItem(id, {
      status: 'pending',
      nextAttemptAt: null,
      lastError: null,
    });
  }

  /** A server-authenticated session makes prior 401 blocks safe to try again. */
  async resumeAfterAuthentication(queue: Queued[]): Promise<void> {
    let changed = false;
    for (const item of queue) {
      const current = this.state.items[item.id];
      if (current?.status !== 'blocked_auth') continue;
      this.state.items[item.id] = {
        ...current,
        status: 'pending',
        nextAttemptAt: null,
        lastError: null,
      };
      changed = true;
    }
    if (changed && this.state.lastError?.kind === 'auth') this.state.lastError = null;
    if (changed) await this.persist();
  }

  ordered(queue: Queued[]): Queued[] {
    return [...queue].sort((a, b) => {
      const aOrder = this.state.items[a.id]?.order ?? 0;
      const bOrder = this.state.items[b.id]?.order ?? 0;
      if (aOrder > 0 && bOrder > 0 && aOrder !== bOrder) return aOrder - bOrder;
      if (aOrder > 0 && bOrder <= 0) return -1;
      if (aOrder <= 0 && bOrder > 0) return 1;
      return a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id);
    });
  }

  projectablePrefix(queue: Queued[]): Queued[] {
    const visible: Queued[] = [];
    for (const item of this.ordered(queue)) {
      const status = this.stateFor(item.id).status;
      if (status === 'rejected') break;
      visible.push(item);
    }
    return visible;
  }

  async recoverInterrupted(queue: Queued[], now = new Date()): Promise<void> {
    const ids = new Set(queue.map((item) => item.id));
    let changed = false;

    // Phase 1 rows created before Phase 3 have no sequence metadata. Adopt them
    // deterministically once, then every new Phase 3 row gets a strict counter.
    const legacyOrder = [...queue].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id));
    for (const item of legacyOrder) {
      const current = this.state.items[item.id];
      if (!current) {
        this.state.items[item.id] = defaultItemState(this.state.nextOrder++);
        changed = true;
      } else if (current.order <= 0) {
        current.order = this.state.nextOrder++;
        changed = true;
      }
    }

    for (const item of this.ordered(queue)) {
      const current = this.state.items[item.id];
      if (current?.status === 'syncing') {
        const at = now.toISOString();
        this.state.items[item.id] = {
          ...current,
          status: 'retry_wait',
          nextAttemptAt: at,
          lastError: {
            kind: 'interrupted',
            message: 'The previous sync stopped before the server response was confirmed. Retrying with the same idempotency key.',
            status: null,
            code: null,
            at,
          },
        };
        changed = true;
      }
    }
    for (const id of Object.keys(this.state.items)) {
      if (!ids.has(id)) {
        delete this.state.items[id];
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async noteRun(at: string): Promise<void> {
    this.state.lastRunAt = at;
    await this.persist();
  }

  async noteSuccess(at: string): Promise<void> {
    this.state.lastSuccessAt = at;
    this.state.lastError = null;
    await this.persist();
  }

  async noteError(error: SyncErrorInfo): Promise<void> {
    this.state.lastError = error;
    await this.persist();
  }

  summary(queue = offlineRepository.queueAll()): SyncSummary {
    let pending = 0;
    let syncing = 0;
    let retrying = 0;
    let blockedAuth = 0;
    let rejected = 0;
    let blockedByOrder = 0;
    let nextRetryAt: string | null = null;
    let orderBlocked = false;

    for (const item of this.ordered(queue)) {
      const state = this.stateFor(item.id);
      if (orderBlocked) blockedByOrder += 1;
      if (state.status === 'pending') pending += 1;
      else if (state.status === 'syncing') syncing += 1;
      else if (state.status === 'retry_wait') {
        retrying += 1;
        if (state.nextAttemptAt && (!nextRetryAt || state.nextAttemptAt < nextRetryAt)) nextRetryAt = state.nextAttemptAt;
      } else if (state.status === 'blocked_auth') blockedAuth += 1;
      else if (state.status === 'rejected') {
        rejected += 1;
        orderBlocked = true;
      }
    }

    return {
      pending,
      syncing,
      retrying,
      blockedAuth,
      rejected,
      blockedByOrder,
      nextRetryAt,
      lastRunAt: this.state.lastRunAt,
      lastSuccessAt: this.state.lastSuccessAt,
      lastError: this.state.lastError ? structuredClone(this.state.lastError) : null,
    };
  }

  async resetForTests(): Promise<void> {
    await this.whenIdle();
    this.deactivate();
    this.writeChain = Promise.resolve();
  }
}

export const offlineSyncState = new OfflineSyncState();

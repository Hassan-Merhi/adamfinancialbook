import type { EntryInput } from '../../shared/types';

/**
 * Durable offline storage for one browser profile.
 *
 * Financial data is always scoped to the authenticated user id.  The only
 * global value is the id of the last active user so an already-authenticated
 * device can reopen its own cached book with no network.  A sign-out clears
 * that pointer and the cached profile/snapshot, while preserving any queued
 * writes under the old user id so a different user can never see or send them.
 */
export const OFFLINE_DB_NAME = 'adam-financial-book-offline';
export const OFFLINE_DB_VERSION = 1;

export const LEGACY_BOOK_KEY = 'book.snapshot';
export const LEGACY_OUTBOX_KEY = 'book.outbox';
export const LEGACY_USER_KEY = 'book.user';

const META = 'meta';
const PROFILES = 'profiles';
const SNAPSHOTS = 'snapshots';
const OUTBOX = 'outbox';
const ATTACHMENTS = 'attachments';
const SYNC_META = 'syncMeta';
const ACTIVE_USER = 'activeUserId';
const LEGACY_MIGRATED = 'legacyMigrated';

interface MetaRecord { key: string; value: unknown }
interface SnapshotRecord { userId: string; value: unknown; updatedAt: string }
interface OutboxRecord extends Queued { key: string; userId: string }
interface AttachmentRecord { key: string; userId: string; id: string; value: unknown; createdAt: string }
interface SyncMetaRecord { userId: string; value: unknown; updatedAt: string }

export interface OfflineUser { id: string; [key: string]: unknown }
export interface Queued { id: string; input: EntryInput; queuedAt: string }

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

function readLocal<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function removeLegacyKeys(): void {
  try {
    localStorage.removeItem(LEGACY_BOOK_KEY);
    localStorage.removeItem(LEGACY_OUTBOX_KEY);
    localStorage.removeItem(LEGACY_USER_KEY);
  } catch { /* storage may be unavailable in private mode */ }
}

function scopedKey(userId: string, id: string): string {
  return `${userId}:${id}`;
}

async function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('Could not open offline storage.'));
    request.onblocked = () => reject(new Error('Offline storage upgrade is blocked by another tab.'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(PROFILES)) db.createObjectStore(PROFILES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS, { keyPath: 'userId' });
      if (!db.objectStoreNames.contains(OUTBOX)) {
        const store = db.createObjectStore(OUTBOX, { keyPath: 'key' });
        store.createIndex('by-user', 'userId', { unique: false });
        store.createIndex('by-user-time', ['userId', 'queuedAt'], { unique: false });
      }
      // Reserved now so later phases can add receipt blobs and richer sync state
      // without putting sensitive data back into localStorage.
      if (!db.objectStoreNames.contains(ATTACHMENTS)) {
        const store = db.createObjectStore(ATTACHMENTS, { keyPath: 'key' });
        store.createIndex('by-user', 'userId', { unique: false });
      }
      if (!db.objectStoreNames.contains(SYNC_META)) db.createObjectStore(SYNC_META, { keyPath: 'userId' });
    };
    request.onsuccess = () => resolve(request.result);
  });
}

class OfflineRepository {
  private db: IDBDatabase | null = null;
  private initialized = false;
  private activeUserId: string | null = null;
  private profiles = new Map<string, OfflineUser>();
  private snapshots = new Map<string, unknown>();
  private queues = new Map<string, Queued[]>();
  private attachments = new Map<string, AttachmentRecord[]>();
  private syncMeta = new Map<string, unknown>();
  private writeChain: Promise<void> = Promise.resolve();

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (typeof indexedDB === 'undefined') {
      // Tests and very old browsers still get an isolated in-memory model.  We
      // intentionally leave the legacy keys in place here because there is no
      // durable replacement available.
      this.migrateLegacyIntoMemory();
      return;
    }

    try {
      this.db = await openOfflineDb();
      this.db.onversionchange = () => {
        this.db?.close();
        this.db = null;
      };
      await this.loadFromDb();
      await this.migrateLegacyIntoDb();
    } catch (error) {
      console.error('Offline storage unavailable; using memory for this session.', error);
      this.db?.close();
      this.db = null;
      this.migrateLegacyIntoMemory();
    }
  }

  private async loadFromDb(): Promise<void> {
    if (!this.db) return;
    const transaction = this.db.transaction([META, PROFILES, SNAPSHOTS, OUTBOX, ATTACHMENTS, SYNC_META], 'readonly');
    const [meta, profiles, snapshots, outbox, attachments, syncMeta] = await Promise.all([
      requestResult(transaction.objectStore(META).getAll()) as Promise<MetaRecord[]>,
      requestResult(transaction.objectStore(PROFILES).getAll()) as Promise<OfflineUser[]>,
      requestResult(transaction.objectStore(SNAPSHOTS).getAll()) as Promise<SnapshotRecord[]>,
      requestResult(transaction.objectStore(OUTBOX).getAll()) as Promise<OutboxRecord[]>,
      requestResult(transaction.objectStore(ATTACHMENTS).getAll()) as Promise<AttachmentRecord[]>,
      requestResult(transaction.objectStore(SYNC_META).getAll()) as Promise<SyncMetaRecord[]>,
    ]);
    await transactionDone(transaction);

    for (const profile of profiles) this.profiles.set(profile.id, profile);
    for (const item of snapshots) this.snapshots.set(item.userId, item.value);
    for (const item of outbox) {
      const queue = this.queues.get(item.userId) ?? [];
      queue.push({ id: item.id, input: item.input, queuedAt: item.queuedAt });
      this.queues.set(item.userId, queue);
    }
    for (const queue of this.queues.values()) queue.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    for (const item of attachments) {
      const list = this.attachments.get(item.userId) ?? [];
      list.push(item);
      this.attachments.set(item.userId, list);
    }
    for (const item of syncMeta) this.syncMeta.set(item.userId, item.value);

    const active = meta.find((item) => item.key === ACTIVE_USER)?.value;
    this.activeUserId = typeof active === 'string' && active ? active : null;
  }

  private legacyState(): { user: OfflineUser | null; snapshot: unknown; queue: Queued[] } {
    const user = readLocal<OfflineUser>(LEGACY_USER_KEY);
    const snapshot = readLocal<unknown>(LEGACY_BOOK_KEY);
    const queue = readLocal<Queued[]>(LEGACY_OUTBOX_KEY) ?? [];
    return {
      user: user && typeof user.id === 'string' && user.id ? user : null,
      snapshot,
      queue: Array.isArray(queue) ? queue.filter((item) => item && typeof item.id === 'string') : [],
    };
  }

  private migrateLegacyIntoMemory(): void {
    const legacy = this.legacyState();
    if (!legacy.user) return;
    const userId = legacy.user.id;
    this.activeUserId = userId;
    this.profiles.set(userId, legacy.user);
    if (legacy.snapshot !== null) this.snapshots.set(userId, legacy.snapshot);
    if (legacy.queue.length) this.queues.set(userId, [...legacy.queue].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)));
  }

  private async migrateLegacyIntoDb(): Promise<void> {
    if (!this.db) return;
    const check = this.db.transaction(META, 'readonly');
    const marker = await requestResult(check.objectStore(META).get(LEGACY_MIGRATED)) as MetaRecord | undefined;
    await transactionDone(check);
    if (marker?.value === true) {
      removeLegacyKeys();
      return;
    }

    const legacy = this.legacyState();
    const transaction = this.db.transaction([META, PROFILES, SNAPSHOTS, OUTBOX], 'readwrite');
    const meta = transaction.objectStore(META);

    if (legacy.user) {
      const userId = legacy.user.id;
      if (!this.profiles.has(userId)) {
        this.profiles.set(userId, legacy.user);
        transaction.objectStore(PROFILES).put(legacy.user);
      }
      if (legacy.snapshot !== null && !this.snapshots.has(userId)) {
        this.snapshots.set(userId, legacy.snapshot);
        transaction.objectStore(SNAPSHOTS).put({ userId, value: legacy.snapshot, updatedAt: new Date().toISOString() } satisfies SnapshotRecord);
      }

      const existing = new Set((this.queues.get(userId) ?? []).map((item) => item.id));
      const merged = this.queues.get(userId) ?? [];
      for (const item of legacy.queue) {
        if (existing.has(item.id)) continue;
        existing.add(item.id);
        merged.push(item);
        transaction.objectStore(OUTBOX).put({ ...item, userId, key: scopedKey(userId, item.id) } satisfies OutboxRecord);
      }
      merged.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
      if (merged.length) this.queues.set(userId, merged);

      if (!this.activeUserId) {
        this.activeUserId = userId;
        meta.put({ key: ACTIVE_USER, value: userId } satisfies MetaRecord);
      }
    }

    meta.put({ key: LEGACY_MIGRATED, value: true } satisfies MetaRecord);
    await transactionDone(transaction);
    removeLegacyKeys();
  }

  private enqueue(work: (db: IDBDatabase) => Promise<void>): Promise<void> {
    if (!this.db) return Promise.resolve();
    this.writeChain = this.writeChain.then(async () => {
      if (this.db) await work(this.db);
    }).catch((error) => {
      console.error('Could not persist offline state.', error);
    });
    return this.writeChain;
  }

  whenIdle(): Promise<void> {
    return this.writeChain;
  }

  setActiveUser<T extends OfflineUser>(user: T): Promise<void> {
    this.activeUserId = user.id;
    this.profiles.set(user.id, user);
    return this.enqueue(async (db) => {
      const transaction = db.transaction([META, PROFILES], 'readwrite');
      transaction.objectStore(META).put({ key: ACTIVE_USER, value: user.id } satisfies MetaRecord);
      transaction.objectStore(PROFILES).put(user);
      await transactionDone(transaction);
    });
  }

  getActiveUser<T>(): T | null {
    if (!this.activeUserId) return null;
    return (this.profiles.get(this.activeUserId) as T | undefined) ?? null;
  }

  /**
   * Sign-out quarantine: the device can no longer reopen cached financial data,
   * but unsent entries stay encrypted-by-origin and user-scoped in IndexedDB so
   * logging back into the same user can recover them.  Another user cannot see
   * or flush that queue because there is no active pointer to it.
   */
  clearSession(): Promise<void> {
    const userId = this.activeUserId;
    this.activeUserId = null;
    if (!userId) return Promise.resolve();
    this.profiles.delete(userId);
    this.snapshots.delete(userId);
    return this.enqueue(async (db) => {
      const transaction = db.transaction([META, PROFILES, SNAPSHOTS], 'readwrite');
      transaction.objectStore(META).delete(ACTIVE_USER);
      transaction.objectStore(PROFILES).delete(userId);
      transaction.objectStore(SNAPSHOTS).delete(userId);
      await transactionDone(transaction);
    });
  }

  saveSnapshot(value: unknown): Promise<void> {
    const userId = this.activeUserId;
    if (!userId) return Promise.resolve();
    if (value === null || value === undefined) this.snapshots.delete(userId);
    else this.snapshots.set(userId, value);
    return this.enqueue(async (db) => {
      const transaction = db.transaction(SNAPSHOTS, 'readwrite');
      if (value === null || value === undefined) transaction.objectStore(SNAPSHOTS).delete(userId);
      else transaction.objectStore(SNAPSHOTS).put({ userId, value, updatedAt: new Date().toISOString() } satisfies SnapshotRecord);
      await transactionDone(transaction);
    });
  }

  loadSnapshot<T>(): T | null {
    if (!this.activeUserId) return null;
    return (this.snapshots.get(this.activeUserId) as T | undefined) ?? null;
  }

  queueAll(): Queued[] {
    if (!this.activeUserId) return [];
    return [...(this.queues.get(this.activeUserId) ?? [])];
  }

  async queueAdd(input: EntryInput): Promise<Queued> {
    const userId = this.activeUserId;
    if (!userId) throw new Error('Offline entry cannot be queued without an active user.');
    const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const id = `q_${random}`;
    const item: Queued = { id, input: { ...input, clientRef: id }, queuedAt: new Date().toISOString() };
    const queue = [...(this.queues.get(userId) ?? []), item];
    this.queues.set(userId, queue);
    await this.enqueue(async (db) => {
      const transaction = db.transaction(OUTBOX, 'readwrite');
      transaction.objectStore(OUTBOX).put({ ...item, userId, key: scopedKey(userId, id) } satisfies OutboxRecord);
      await transactionDone(transaction);
    });
    return item;
  }

  queueDrop(id: string): Promise<void> {
    const userId = this.activeUserId;
    if (!userId) return Promise.resolve();
    this.queues.set(userId, (this.queues.get(userId) ?? []).filter((item) => item.id !== id));
    return this.enqueue(async (db) => {
      const transaction = db.transaction(OUTBOX, 'readwrite');
      transaction.objectStore(OUTBOX).delete(scopedKey(userId, id));
      await transactionDone(transaction);
    });
  }

  queueClear(): Promise<void> {
    const userId = this.activeUserId;
    if (!userId) return Promise.resolve();
    const ids = (this.queues.get(userId) ?? []).map((item) => item.id);
    this.queues.set(userId, []);
    return this.enqueue(async (db) => {
      const transaction = db.transaction(OUTBOX, 'readwrite');
      const store = transaction.objectStore(OUTBOX);
      for (const id of ids) store.delete(scopedKey(userId, id));
      await transactionDone(transaction);
    });
  }

  /** Used by deterministic unit tests; production never calls this. */
  async resetForTests(): Promise<void> {
    await this.whenIdle();
    this.db?.close();
    this.db = null;
    this.initialized = false;
    this.activeUserId = null;
    this.profiles.clear();
    this.snapshots.clear();
    this.queues.clear();
    this.attachments.clear();
    this.syncMeta.clear();
    this.writeChain = Promise.resolve();
    if (typeof indexedDB !== 'undefined') {
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(OFFLINE_DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      });
    }
  }
}

export const offlineRepository = new OfflineRepository();

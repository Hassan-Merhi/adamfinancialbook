import { lastUser } from './offline';
import { OFFLINE_DB_NAME } from './offline-db';

export const OFFLINE_ATTACHMENT_EVENT = 'book:offline-attachment-change';
export const MAX_OFFLINE_ATTACHMENTS_PER_ENTRY = 20;
export const MAX_OFFLINE_ATTACHMENT_BYTES = 6 * 1024 * 1024;

export type OfflineAttachmentStatus = 'waiting' | 'uploading' | 'uploaded' | 'failed';

export interface OfflineAttachmentRecord {
  id: string;
  userId: string;
  entryId: string | null;
  entryClientRef: string | null;
  filename: string;
  mimeType: string;
  byteSize: number;
  blob: Blob | null;
  status: OfflineAttachmentStatus;
  attempts: number;
  queuedAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  uploadedAt: string | null;
  lastError: string | null;
}

export interface OfflineAttachmentSummary {
  waiting: number;
  uploading: number;
  uploaded: number;
  failed: number;
  total: number;
}

type StoredAttachment = {
  key: string;
  userId: string;
  id: string;
  value: OfflineAttachmentRecord;
  createdAt: string;
};

type ActiveUser = { id: string };

type AttachmentTarget =
  | { entryId: string; clientRef?: never }
  | { entryId?: never; clientRef: string };

const ATTACHMENTS = 'attachments';
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const memory = new Map<string, StoredAttachment>();
let dbPromise: Promise<IDBDatabase | null> | null = null;
let flushing: Promise<number> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function activeUserId(): string | null {
  return lastUser.load<ActiveUser>()?.id ?? null;
}

function storageKey(userId: string, id: string): string {
  return `${userId}:${id}`;
}

function newAttachmentId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now()}${Math.random().toString(36).slice(2, 14)}`;
  return `att_sync_${random}`;
}

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

async function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      reject(new Error('Offline storage must initialize before receipt storage.'));
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open offline receipt storage.'));
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ATTACHMENTS)) {
        db.close();
        reject(new Error('This browser does not have the receipt queue store yet. Reload after the app finishes updating.'));
        return;
      }
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

async function readAll(): Promise<StoredAttachment[]> {
  const db = await openDb();
  if (!db) return [...memory.values()];
  const transaction = db.transaction(ATTACHMENTS, 'readonly');
  const rows = await requestResult(transaction.objectStore(ATTACHMENTS).getAll()) as StoredAttachment[];
  await transactionDone(transaction);
  return rows;
}

async function put(record: OfflineAttachmentRecord): Promise<void> {
  const stored: StoredAttachment = {
    key: storageKey(record.userId, record.id),
    userId: record.userId,
    id: record.id,
    value: record,
    createdAt: record.queuedAt,
  };
  const db = await openDb();
  if (!db) {
    memory.set(stored.key, stored);
    emitChange();
    return;
  }
  const transaction = db.transaction(ATTACHMENTS, 'readwrite');
  transaction.objectStore(ATTACHMENTS).put(stored);
  await transactionDone(transaction);
  emitChange();
}

async function recordsForUser(userId: string): Promise<OfflineAttachmentRecord[]> {
  const rows = await readAll();
  return rows
    .filter((item) => item.userId === userId)
    .map((item) => item.value)
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

function emitChange(): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OFFLINE_ATTACHMENT_EVENT));
}

function retryDelayMs(attempts: number): number {
  return Math.min(5 * 60_000, 2_000 * 2 ** Math.max(0, Math.min(attempts - 1, 8)));
}

function scheduleRetry(at: string): void {
  if (typeof window === 'undefined' || typeof setTimeout === 'undefined') return;
  const target = Date.parse(at);
  if (!Number.isFinite(target)) return;
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushOfflineAttachments();
  }, Math.max(0, target - Date.now()));
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveEntryId(record: OfflineAttachmentRecord): Promise<string | null> {
  if (record.entryId) return record.entryId;
  if (!record.entryClientRef) return null;
  const response = await fetch(`/api/offline/entries/by-client-ref/${encodeURIComponent(record.entryClientRef)}`, {
    method: 'GET',
    credentials: 'same-origin',
  });
  if (response.status === 404) return null;
  if (response.status === 401) throw new Error('Sign in again before receipts can sync.');
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Could not resolve the synced transaction (${response.status}).`);
  }
  const body = await response.json() as { id?: string };
  return typeof body.id === 'string' ? body.id : null;
}

async function upload(record: OfflineAttachmentRecord, entryId: string): Promise<Response> {
  if (!record.blob) throw new Error('The local receipt data is missing.');
  return fetch(`/api/delegation/attachments/entry/${encodeURIComponent(entryId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': record.mimeType || 'application/octet-stream',
      'x-book': '1',
      'x-offline-attachment-id': record.id,
    },
    body: record.blob,
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function attempt(record: OfflineAttachmentRecord, force: boolean): Promise<boolean> {
  if (record.status === 'uploaded') return false;
  if (record.status === 'failed' && !force) return false;
  if (!force && record.nextAttemptAt && Date.parse(record.nextAttemptAt) > Date.now()) {
    scheduleRetry(record.nextAttemptAt);
    return false;
  }

  const attemptAt = new Date().toISOString();
  const working: OfflineAttachmentRecord = {
    ...record,
    status: 'uploading',
    attempts: record.attempts + 1,
    lastAttemptAt: attemptAt,
    nextAttemptAt: null,
    lastError: null,
  };
  await put(working);

  try {
    const entryId = await resolveEntryId(working);
    if (!entryId) {
      const nextAttemptAt = new Date(Date.now() + retryDelayMs(working.attempts)).toISOString();
      await put({
        ...working,
        status: 'waiting',
        nextAttemptAt,
        lastError: 'Waiting for the transaction itself to finish syncing.',
      });
      scheduleRetry(nextAttemptAt);
      return false;
    }

    if (working.entryId !== entryId) {
      working.entryId = entryId;
      await put(working);
    }

    const response = await upload(working, entryId);
    if (response.ok) {
      await put({
        ...working,
        entryId,
        blob: null,
        status: 'uploaded',
        uploadedAt: new Date().toISOString(),
        nextAttemptAt: null,
        lastError: null,
      });
      return true;
    }

    const text = await response.text();
    const message = text || `Receipt upload failed (${response.status}).`;
    if (isRetryableStatus(response.status)) {
      const nextAttemptAt = new Date(Date.now() + retryDelayMs(working.attempts)).toISOString();
      await put({ ...working, entryId, status: 'waiting', nextAttemptAt, lastError: message });
      scheduleRetry(nextAttemptAt);
      return false;
    }

    await put({ ...working, entryId, status: 'failed', nextAttemptAt: null, lastError: message });
    return false;
  } catch (error) {
    const nextAttemptAt = new Date(Date.now() + retryDelayMs(working.attempts)).toISOString();
    await put({
      ...working,
      status: 'waiting',
      nextAttemptAt,
      lastError: safeError(error),
    });
    scheduleRetry(nextAttemptAt);
    return false;
  }
}

export function validateAttachmentFiles(files: readonly File[]): File[] {
  if (files.length > MAX_OFFLINE_ATTACHMENTS_PER_ENTRY) {
    throw new Error(`Attach at most ${MAX_OFFLINE_ATTACHMENTS_PER_ENTRY} receipts to one transaction.`);
  }
  const accepted: File[] = [];
  for (const file of files) {
    if (!file.size) throw new Error(`${file.name || 'A file'} is empty.`);
    if (file.size > MAX_OFFLINE_ATTACHMENT_BYTES) {
      throw new Error(`${file.name || 'A file'} is larger than 6 MB.`);
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      throw new Error(`${file.name || 'That file'} must be a JPG, PNG, WebP or PDF.`);
    }
    accepted.push(file);
  }
  return accepted;
}

export async function queueEntryAttachments(
  files: readonly File[],
  target: AttachmentTarget,
): Promise<OfflineAttachmentRecord[]> {
  const userId = activeUserId();
  if (!userId) throw new Error('Sign in before storing a receipt.');
  const checked = validateAttachmentFiles(files);
  const queuedAt = new Date().toISOString();
  const records: OfflineAttachmentRecord[] = [];
  for (const file of checked) {
    const record: OfflineAttachmentRecord = {
      id: newAttachmentId(),
      userId,
      entryId: 'entryId' in target ? target.entryId : null,
      entryClientRef: 'clientRef' in target ? target.clientRef : null,
      filename: file.name || 'receipt',
      mimeType: file.type,
      byteSize: file.size,
      blob: file.slice(0, file.size, file.type),
      status: 'waiting',
      attempts: 0,
      queuedAt,
      lastAttemptAt: null,
      nextAttemptAt: null,
      uploadedAt: null,
      lastError: null,
    };
    await put(record);
    records.push(record);
  }
  if (typeof navigator === 'undefined' || navigator.onLine !== false) void flushOfflineAttachments();
  return records;
}

export async function flushOfflineAttachments(options: { force?: boolean } = {}): Promise<number> {
  if (flushing) return flushing;
  flushing = (async () => {
    const userId = activeUserId();
    if (!userId) return 0;
    const records = await recordsForUser(userId);
    let uploaded = 0;
    for (const record of records) {
      const recovered = record.status === 'uploading'
        ? { ...record, status: 'waiting' as const, nextAttemptAt: null, lastError: 'Upload was interrupted and will resume.' }
        : record;
      if (recovered !== record) await put(recovered);
      if (await attempt(recovered, options.force === true)) uploaded += 1;
    }
    return uploaded;
  })().finally(() => { flushing = null; });
  return flushing;
}

export async function retryFailedAttachments(): Promise<number> {
  const userId = activeUserId();
  if (!userId) return 0;
  const records = await recordsForUser(userId);
  for (const record of records) {
    if (record.status !== 'failed') continue;
    await put({ ...record, status: 'waiting', nextAttemptAt: null, lastError: null });
  }
  return flushOfflineAttachments({ force: true });
}

export async function attachmentSummary(): Promise<OfflineAttachmentSummary> {
  const userId = activeUserId();
  const records = userId ? await recordsForUser(userId) : [];
  const summary: OfflineAttachmentSummary = { waiting: 0, uploading: 0, uploaded: 0, failed: 0, total: records.length };
  for (const record of records) summary[record.status] += 1;
  return summary;
}

export async function attachmentRecords(): Promise<OfflineAttachmentRecord[]> {
  const userId = activeUserId();
  return userId ? recordsForUser(userId) : [];
}

export async function resetOfflineAttachmentsForTests(): Promise<void> {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  flushing = null;
  memory.clear();
}

export const attachmentQueue = {
  queue: queueEntryAttachments,
  flush: flushOfflineAttachments,
  retryFailed: retryFailedAttachments,
  summary: attachmentSummary,
  records: attachmentRecords,
  validate: validateAttachmentFiles,
};

if (typeof window !== 'undefined') {
  const resume = () => { void flushOfflineAttachments(); };
  window.addEventListener('online', resume);
  window.addEventListener('focus', resume);
  window.addEventListener('book:offline-auto-sync-result', resume);
  queueMicrotask(resume);
}

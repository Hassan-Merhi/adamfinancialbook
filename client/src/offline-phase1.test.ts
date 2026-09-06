import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Advanced offline Phase 1 contract', () => {
  it('uses IndexedDB as the durable financial offline store', () => {
    const db = read('client/src/offline-db.ts');
    expect(db).toContain("indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION)");
    expect(db).toContain("db.createObjectStore(PROFILES");
    expect(db).toContain("db.createObjectStore(SNAPSHOTS");
    expect(db).toContain("db.createObjectStore(OUTBOX");
    expect(db).toContain("db.createObjectStore(ATTACHMENTS");
    expect(db).toContain("db.createObjectStore(SYNC_META");
    expect(db).toContain("store.createIndex('by-user'");
  });

  it('scopes snapshots and queued financial entries to the authenticated user id', () => {
    const db = read('client/src/offline-db.ts');
    expect(db).toContain('private activeUserId: string | null = null');
    expect(db).toContain('const userId = this.activeUserId');
    expect(db).toContain('scopedKey(userId, id)');
    expect(db).toContain('if (!this.activeUserId) return []');
    expect(db).toContain("Offline entry cannot be queued without an active user.");
  });

  it('uses localStorage financial keys only as a one-time migration source', () => {
    const db = read('client/src/offline-db.ts');
    const facade = read('client/src/offline.ts');
    expect(db).toContain("LEGACY_BOOK_KEY = 'book.snapshot'");
    expect(db).toContain("LEGACY_OUTBOX_KEY = 'book.outbox'");
    expect(db).toContain("LEGACY_USER_KEY = 'book.user'");
    expect(db).toContain('migrateLegacyIntoDb');
    expect(db).toContain('removeLegacyKeys();');
    expect(facade).not.toContain('localStorage.getItem');
    expect(facade).not.toContain('localStorage.setItem');
  });

  it('hydrates IndexedDB before React reads cached user, snapshot, or outbox state', () => {
    const main = read('client/src/main.tsx');
    expect(main).toContain("import { initializeOfflineStorage } from './offline'");
    expect(main).toContain('await initializeOfflineStorage();');
    expect(main.indexOf('await initializeOfflineStorage();')).toBeLessThan(main.indexOf('createRoot('));
  });

  it('quarantines cached session data on logout without exposing another user queue', () => {
    const db = read('client/src/offline-db.ts');
    expect(db).toContain('clearSession(): Promise<void>');
    expect(db).toContain('this.activeUserId = null');
    expect(db).toContain('this.profiles.delete(userId)');
    expect(db).toContain('this.snapshots.delete(userId)');
    // The queue is deliberately not deleted here: it remains under its old
    // userId and is inaccessible until that same user signs in again.
    const clearSession = db.slice(db.indexOf('clearSession(): Promise<void>'), db.indexOf('saveSnapshot(value: unknown)'));
    expect(clearSession).not.toContain('this.queues.delete');
    expect(clearSession).not.toContain('objectStore(OUTBOX)');
  });
});

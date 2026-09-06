import type { EntryInput } from '../../shared/types';
import { offlineRepository, type OfflineUser, type Queued } from './offline-db';

export type { Queued } from './offline-db';

/**
 * Phase 1 offline foundation.
 *
 * The browser boots the IndexedDB repository before React renders. These small
 * facades keep the rest of the app simple while all sensitive cached state is
 * stored per user instead of in global localStorage keys.
 */
export async function initializeOfflineStorage(): Promise<void> {
  await offlineRepository.initialize();
}

export async function resetOfflineStorageForTests(): Promise<void> {
  await offlineRepository.resetForTests();
}

export const snapshot = {
  save: (book: unknown) => offlineRepository.saveSnapshot(book),
  load: <T>(): T | null => offlineRepository.loadSnapshot<T>(),
};

/**
 * Who was holding the book last time. The repository stores only a global
 * pointer to that user id; the actual profile, snapshot and queued work live in
 * separate user-scoped records.
 */
export const lastUser = {
  save: <T extends OfflineUser>(user: T | null) => user ? offlineRepository.setActiveUser(user) : Promise.resolve(),
  load: <T>(): T | null => offlineRepository.getActiveUser<T>(),
  clear: () => offlineRepository.clearSession(),
};

export const outbox = {
  all: (): Queued[] => offlineRepository.queueAll(),
  add: (input: EntryInput): Promise<Queued> => offlineRepository.queueAdd(input),
  drop: (id: string): Promise<void> => offlineRepository.queueDrop(id),
  clear: (): Promise<void> => offlineRepository.queueClear(),
  whenIdle: (): Promise<void> => offlineRepository.whenIdle(),
};

/** True when the browser says there is no network — treat anything else as a real error. */
export function looksOffline(err: unknown): boolean {
  return !navigator.onLine || (err instanceof TypeError); // fetch throws TypeError when it cannot reach the host
}

/**
 * Sends what is waiting, oldest first, and stops at the first failure so the
 * order in which things happened is never scrambled.
 */
let flushing: Promise<number> | null = null;

export async function flushOutbox(send: (input: EntryInput) => Promise<unknown>): Promise<number> {
  if (flushing) return flushing;
  flushing = runFlush(send).finally(() => { flushing = null; });
  return flushing;
}

async function runFlush(send: (input: EntryInput) => Promise<unknown>): Promise<number> {
  let sent = 0;
  for (const item of outbox.all()) {
    try {
      await send(item.input);
      // Do not report completion until the durable queue record is gone.
      await outbox.drop(item.id);
      sent += 1;
    } catch (err) {
      if (looksOffline(err)) break;
      // Phase 3 will replace this terminal refusal behavior with richer durable
      // rejected/conflict states. Phase 1 preserves the existing semantics.
      await outbox.drop(item.id);
      throw err;
    }
  }
  return sent;
}

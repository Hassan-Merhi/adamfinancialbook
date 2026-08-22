/**
 * Working with no signal.
 *
 * Two small things, both deliberately dumb:
 *   - the last book the server sent is kept, so the app opens with figures
 *     rather than a spinner when there is no network;
 *   - anything you log while offline waits in an outbox and is sent, in order,
 *     the moment the network is back.
 *
 * The outbox only ever holds entries. Setting the book up, correcting an entry
 * and anything else that reshapes it needs the server there and then — those
 * fail honestly rather than queueing.
 */
import type { EntryInput } from '../../shared/types';

const BOOK_KEY = 'book.snapshot';
const OUTBOX_KEY = 'book.outbox';
const USER_KEY = 'book.user';

export interface Queued { id: string; input: EntryInput; queuedAt: string; }

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}

function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or private: carry on */ }
}

export const snapshot = {
  save: (book: unknown) => write(BOOK_KEY, book),
  load: <T>(): T | null => read<T | null>(BOOK_KEY, null),
};

/**
 * Who was holding the book last time. With no signal the server cannot confirm
 * the session, but the cookie is still there — so the book opens as it was
 * rather than showing the door to someone already signed in.
 */
export const lastUser = {
  save: (user: unknown) => write(USER_KEY, user),
  load: <T>(): T | null => read<T | null>(USER_KEY, null),
  clear: () => { try { localStorage.removeItem(USER_KEY); } catch { /* nothing to do */ } },
};

export const outbox = {
  all: (): Queued[] => read<Queued[]>(OUTBOX_KEY, []),
  add(input: EntryInput): Queued {
    const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // the reference travels with the entry, so a double send lands once
    const item: Queued = { id, input: { ...input, clientRef: id }, queuedAt: new Date().toISOString() };
    write(OUTBOX_KEY, [...outbox.all(), item]);
    return item;
  },
  drop(id: string) { write(OUTBOX_KEY, outbox.all().filter((q) => q.id !== id)); },
  clear() { write(OUTBOX_KEY, []); },
};

/** True when the browser says there is no network — treat anything else as a real error. */
export function looksOffline(err: unknown): boolean {
  return !navigator.onLine || (err instanceof TypeError);   // fetch throws TypeError when it cannot reach the host
}

/**
 * Sends what is waiting, oldest first, and stops at the first failure so the
 * order in which things happened is never scrambled.
 */
let flushing: Promise<number> | null = null;

export async function flushOutbox(send: (input: EntryInput) => Promise<unknown>): Promise<number> {
  // Two events can arrive at once when the network returns; only one flush runs.
  if (flushing) return flushing;
  flushing = runFlush(send).finally(() => { flushing = null; });
  return flushing;
}

async function runFlush(send: (input: EntryInput) => Promise<unknown>): Promise<number> {
  let sent = 0;
  for (const item of outbox.all()) {
    try {
      await send(item.input);
      outbox.drop(item.id);
      sent += 1;
    } catch (err) {
      if (looksOffline(err)) break;      // still no network: leave the rest for later
      outbox.drop(item.id);              // the server refused it; it will never be accepted
      throw err;
    }
  }
  return sent;
}

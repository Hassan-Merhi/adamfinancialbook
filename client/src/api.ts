/** Everything the screens know about the server. */
import type { Book, Entry, EntryInput, ProjectReceipt } from '../../shared/types';
import type { Draft } from '../../shared/parse';

export interface Balances {
  totalCash: number;
  accounts: Record<string, number>;
  businesses: Record<string, number>;
  people: Record<string, number>;
  loans: Record<string, number>;
  projects: Record<string, number>;
}
export type LoadedBook = Book & { balances: Balances };

/** Thrown when the session is gone, so the app can show the door rather than an error. */
export class NotSignedIn extends Error {
  constructor() { super('Sign in to open the book.'); }
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    // the cookie is the session; the header is what a cross-site form cannot send
    headers: { 'content-type': 'application/json', 'x-book': '1' },
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? safeParse(text) : null;
  if (res.status === 401) throw new NotSignedIn();
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

function safeParse(text: string) {
  try { return JSON.parse(text); } catch { return null; }
}

export interface Me { user: { id: string; email: string; role: 'owner' | 'entry' } | null; needsFirstOwner: boolean }

export interface Reading { draft: Draft; source: 'claude' | 'rules'; duplicate: ProjectReceipt | null }

export const api = {
  me: () => send<Me>('/me', 'GET'),
  login: (email: string, password: string) => send<Me>('/login', 'POST', { email, password }),
  firstOwner: (email: string, password: string) => send<Me>('/first-owner', 'POST', { email, password }),
  logout: () => send('/logout', 'POST'),
  book: () => send<LoadedBook>('/book', 'GET'),
  read: (text: string, today: string) => send<Reading>('/read', 'POST', { text, today }),
  addBusiness: (name: string) => send('/businesses', 'POST', { name }),
  addAccount: (b: { name: string; businessId: string; opening: number }) => send('/accounts', 'POST', b),
  addProject: (b: { name: string; businessId: string; opening: number; scope?: string }) => send('/projects', 'POST', b),
  addPerson: (b: { name: string; businessId: string; kind: string; opening: number; salary: number; role: string }) =>
    send('/people', 'POST', b),
  setLoan: (b: { fromBusiness: string; toBusiness: string; opening: number }) => send('/loans', 'PUT', b),
  addEntry: (input: EntryInput) => send<Entry>('/entries', 'POST', input),
  addReminder: (b: { what: string; amount: number; accountId: string | null; note?: string }) =>
    send('/reminders', 'POST', b),
  clearReminder: (id: string) => send(`/reminders/${id}`, 'DELETE'),
  correct: (id: string, amount: number) => send(`/entries/${id}`, 'PATCH', { amount }),
};

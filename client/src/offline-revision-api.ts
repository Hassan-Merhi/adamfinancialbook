import { api, ApiError, NotSignedIn } from './api';
import type { EntryInput } from '../../shared/types';
import {
  isOfflineCorrectionInput,
  isOfflineRevisionInput,
  type OfflineRevisionInput,
} from '../../shared/offline-conflict';

function safeParse(text: string) {
  try { return JSON.parse(text); } catch { return null; }
}

async function sendRevision(input: OfflineRevisionInput): Promise<unknown> {
  const clientRef = input.clientRef;
  if (!clientRef) throw new Error('Offline revision is missing its durable client reference.');
  const path = isOfflineCorrectionInput(input)
    ? `/api/entries/${encodeURIComponent(input.entryId)}`
    : `/api/entries/${encodeURIComponent(input.entryId)}/void`;
  const body = isOfflineCorrectionInput(input)
    ? { amount: input.amount, clientRef, offlineContext: input.offlineContext }
    : { reason: input.reason, clientRef, offlineContext: input.offlineContext };
  const response = await fetch(path, {
    method: isOfflineCorrectionInput(input) ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json', 'x-book': '1' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? safeParse(text) : null;
  if (response.status === 401) throw new NotSignedIn();
  if (!response.ok) {
    const said = data?.error ?? (text ? text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '');
    throw new ApiError(said || `Request failed (${response.status})`, response.status, data?.code);
  }
  return data;
}

/** One sender for the strict outbox: ordinary entries, corrections, and voids. */
export function sendOfflineQueued(input: EntryInput): Promise<unknown> {
  if (isOfflineRevisionInput(input)) return sendRevision(input);
  return api.addEntry(input);
}

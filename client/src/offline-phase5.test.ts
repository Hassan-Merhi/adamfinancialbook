import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeOfflineStorage, lastUser, resetOfflineStorageForTests } from './offline';
import {
  MAX_OFFLINE_ATTACHMENT_BYTES,
  attachmentQueue,
  resetOfflineAttachmentsForTests,
} from './offline-attachments';

function receipt(name = 'receipt.png', type = 'image/png', bytes = 16): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Offline Phase 5 attachment queue', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetOfflineAttachmentsForTests();
    await resetOfflineStorageForTests();
    await initializeOfflineStorage();
    await lastUser.save({ id: 'user_phase5', email: 'offline@example.com', role: 'entry' });
  });

  it('keeps blobs user-scoped and uploads every queued receipt once', async () => {
    const uploads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/offline/entries/by-client-ref/')) return json(200, { id: 'ent_synced' });
      if (url.includes('/delegation/attachments/entry/')) {
        uploads.push(String(new Headers(init?.headers).get('x-offline-attachment-id')));
        return json(201, { ok: true });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    await attachmentQueue.queue([
      receipt('one.png'),
      receipt('two.png'),
    ], { clientRef: 'q_phase5_entry' });

    expect(await attachmentQueue.summary()).toEqual({ waiting: 2, uploading: 0, uploaded: 0, failed: 0, total: 2 });
    expect(await attachmentQueue.flush({ force: true })).toBe(2);

    const records = await attachmentQueue.records();
    expect(records.map((item) => item.status)).toEqual(['uploaded', 'uploaded']);
    expect(records.every((item) => item.entryId === 'ent_synced' && item.blob === null)).toBe(true);
    expect(new Set(uploads).size).toBe(2);

    await lastUser.save({ id: 'another_user', email: 'other@example.com', role: 'entry' });
    expect((await attachmentQueue.summary()).total).toBe(0);
    await lastUser.save({ id: 'user_phase5', email: 'offline@example.com', role: 'entry' });
    expect((await attachmentQueue.summary()).uploaded).toBe(2);
  });

  it('retries an uncertain upload with the same stable attachment id', async () => {
    let uploadCalls = 0;
    const ids: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/offline/entries/by-client-ref/')) return json(200, { id: 'ent_uncertain' });
      if (url.includes('/delegation/attachments/entry/')) {
        uploadCalls += 1;
        ids.push(String(new Headers(init?.headers).get('x-offline-attachment-id')));
        if (uploadCalls === 1) throw new TypeError('network disappeared after send');
        return json(200, { id: ids[0], deduplicated: true });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    await attachmentQueue.queue([receipt()], { clientRef: 'q_uncertain' });
    expect(await attachmentQueue.flush({ force: true })).toBe(0);
    expect((await attachmentQueue.records())[0].status).toBe('waiting');

    expect(await attachmentQueue.flush({ force: true })).toBe(1);
    expect((await attachmentQueue.records())[0].status).toBe('uploaded');
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('keeps permanent failures reviewable and retries them only on request', async () => {
    let accept = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/offline/entries/by-client-ref/')) return json(200, { id: 'ent_failed' });
      if (url.includes('/delegation/attachments/entry/')) {
        return accept ? json(200, { deduplicated: true }) : json(415, { error: 'Unsupported evidence.' });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    await attachmentQueue.queue([receipt()], { clientRef: 'q_failed' });
    await attachmentQueue.flush({ force: true });
    expect(await attachmentQueue.summary()).toMatchObject({ failed: 1, waiting: 0 });

    accept = true;
    expect(await attachmentQueue.retryFailed()).toBe(1);
    expect(await attachmentQueue.summary()).toMatchObject({ failed: 0, uploaded: 1 });
  });

  it('rejects unsupported, empty, oversized, or excessive files before queueing', () => {
    expect(() => attachmentQueue.validate([receipt('bad.txt', 'text/plain')])).toThrow(/JPG, PNG, WebP or PDF/);
    expect(() => attachmentQueue.validate([receipt('empty.png', 'image/png', 0)])).toThrow(/empty/);
    expect(() => attachmentQueue.validate([
      receipt('huge.png', 'image/png', MAX_OFFLINE_ATTACHMENT_BYTES + 1),
    ])).toThrow(/larger than 6 MB/);
    expect(() => attachmentQueue.validate(
      Array.from({ length: 21 }, (_, index) => receipt(`${index}.png`)),
    )).toThrow(/at most 20/);
  });
});

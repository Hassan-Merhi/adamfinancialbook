import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeOfflineStorage, lastUser, resetOfflineStorageForTests } from './offline';
import { attachmentQueue, resetOfflineAttachmentsForTests } from './offline-attachments';

function receipt(name: string): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], name, { type: 'image/png' });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetOfflineAttachmentsForTests();
  await resetOfflineStorageForTests();
  await initializeOfflineStorage();
  await lastUser.save({ id: 'phase5_owner', email: 'owner@example.com', role: 'owner' });
});

describe('Offline Phase 5 attachment hardening', () => {
  it('removes orphaned local receipts when an unsynced entry is discarded', async () => {
    await attachmentQueue.queue([receipt('one.png'), receipt('two.png')], { clientRef: 'q_drop_me' });
    await attachmentQueue.queue([receipt('keep.png')], { clientRef: 'q_keep_me' });

    expect((await attachmentQueue.records())).toHaveLength(3);
    expect(await attachmentQueue.discardForClientRef('q_drop_me')).toBe(2);

    const remaining = await attachmentQueue.records();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].entryClientRef).toBe('q_keep_me');
  });

  it('stops before upload if the signed-in user changes during entry resolution', async () => {
    let switched = false;
    let uploadCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/offline/entries/by-client-ref/')) {
        if (!switched) {
          switched = true;
          await lastUser.save({ id: 'different_user', email: 'other@example.com', role: 'entry' });
        }
        return json(200, { id: 'ent_phase5_switch' });
      }
      if (url.includes('/delegation/attachments/entry/')) {
        uploadCalls += 1;
        return json(201, { ok: true });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    await attachmentQueue.queue([receipt('switch.png')], { clientRef: 'q_switch_user' });
    expect(await attachmentQueue.flush({ force: true })).toBe(0);
    expect(uploadCalls).toBe(0);

    await lastUser.save({ id: 'phase5_owner', email: 'owner@example.com', role: 'owner' });
    const waiting = await attachmentQueue.records();
    expect(waiting[0].status).toBe('waiting');
    expect(waiting[0].lastError).toMatch(/signed-in user changed/i);

    expect(await attachmentQueue.flush({ force: true })).toBe(1);
    expect(uploadCalls).toBe(1);
  });

  it('enforces the 20-receipt limit across multiple queue operations for the same entry', async () => {
    await attachmentQueue.queue(Array.from({ length: 12 }, (_, index) => receipt(`a-${index}.png`)), { clientRef: 'q_target_limit' });
    await attachmentQueue.queue(Array.from({ length: 8 }, (_, index) => receipt(`b-${index}.png`)), { clientRef: 'q_target_limit' });
    expect((await attachmentQueue.records())).toHaveLength(20);

    await expect(attachmentQueue.queue([receipt('too-many.png')], { clientRef: 'q_target_limit' }))
      .rejects.toThrow(/at most 20/);
  });
});

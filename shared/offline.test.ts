import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A localStorage and a navigator, so the offline layer can be tested honestly. */
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});
vi.stubGlobal('navigator', { onLine: true });

const { flushOutbox, looksOffline, outbox, snapshot } = await import('../client/src/offline.js');
import type { EntryInput } from './types.js';

const entry = (amount: number, purpose: string): EntryInput => ({
  occurredOn: '2026-08-22', kind: 'expense', amount, purpose, raw: '', accountId: 'con_cash',
});

beforeEach(() => { store.clear(); (navigator as { onLine: boolean }).onLine = true; });

describe('with no signal', () => {
  it('keeps the last book so the app opens with figures', () => {
    snapshot.save({ totalCash: 1_000 });
    expect(snapshot.load<{ totalCash: number }>()?.totalCash).toBe(1_000);
  });

  it('holds entries in order and sends them oldest first', async () => {
    outbox.add(entry(100, 'One'));
    outbox.add(entry(200, 'Two'));
    const sent: string[] = [];

    const count = await flushOutbox(async (i) => { sent.push(i.purpose); });
    expect(sent).toEqual(['One', 'Two']);
    expect(count).toBe(2);
    expect(outbox.all()).toEqual([]);
  });

  it('stops at the first entry it still cannot send, and keeps the rest', async () => {
    outbox.add(entry(100, 'One'));
    outbox.add(entry(200, 'Two'));
    (navigator as { onLine: boolean }).onLine = false;

    const count = await flushOutbox(async () => { throw new TypeError('Failed to fetch'); });
    expect(count).toBe(0);
    expect(outbox.all()).toHaveLength(2);   // nothing lost, nothing reordered
  });

  it('drops an entry the server refuses, and says so', async () => {
    outbox.add(entry(100, 'One'));
    await expect(flushOutbox(async () => { throw new Error('A transfer needs both accounts.'); }))
      .rejects.toThrow('A transfer needs both accounts.');
    expect(outbox.all()).toHaveLength(0);   // it would never be accepted, so it does not sit there forever
  });

  it('knows a lost network from a refusal', () => {
    expect(looksOffline(new TypeError('Failed to fetch'))).toBe(true);
    expect(looksOffline(new Error('That does not look right'))).toBe(false);
    (navigator as { onLine: boolean }).onLine = false;
    expect(looksOffline(new Error('anything'))).toBe(true);
  });
});

describe('the same entry can never land twice', () => {
  it('stamps every queued entry with its own reference', () => {
    const queued = outbox.add(entry(100, 'One'));
    expect(queued.input.clientRef).toBe(queued.id);
  });

  it('runs one flush even when the network returns twice at once', async () => {
    outbox.add(entry(100, 'One'));
    outbox.add(entry(200, 'Two'));
    const sent: string[] = [];
    const slow = async (i: EntryInput) => {
      await new Promise((r) => setTimeout(r, 10));
      sent.push(i.purpose);
    };

    const [a, b] = await Promise.all([flushOutbox(slow), flushOutbox(slow)]);
    expect(sent).toEqual(['One', 'Two']);   // not four
    expect(a).toBe(2);
    expect(b).toBe(2);                       // the second call joined the first
    expect(outbox.all()).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Advanced offline Phase 3 contract', () => {
  it('uses Phase 1 reserved syncMeta storage without changing the IndexedDB schema version', () => {
    const db = read('client/src/offline-db.ts');
    const state = read('client/src/offline-sync-state.ts');
    expect(db).toContain('export const OFFLINE_DB_VERSION = 1;');
    expect(db).toContain("const SYNC_META = 'syncMeta';");
    expect(state).toContain("const SYNC_META_STORE = 'syncMeta';");
    expect(state).toContain('indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION)');
  });

  it('persists explicit queue states, strict enqueue order, and recovers interrupted syncing work', () => {
    const state = read('client/src/offline-sync-state.ts');
    const offline = read('client/src/offline.ts');
    for (const status of ['pending', 'syncing', 'retry_wait', 'blocked_auth', 'rejected']) {
      expect(state).toContain(`'${status}'`);
    }
    expect(state).toContain('nextOrder: 1');
    expect(state).toContain('this.state.nextOrder++');
    expect(state).toContain('recoverInterrupted(queue: Queued[]');
    expect(state).toContain("current?.status === 'syncing'");
    expect(state).toContain("status: 'retry_wait'");
    expect(state).toContain("kind: 'interrupted'");
    // Phase 4's effective() keeps the same durable ordering while overlaying a
    // reviewed conflict input without mutating the original outbox row.
    expect(state).toContain('return this.ordered(queue).map((item) => {');
    expect(offline).toContain('offlineSyncState.effective(offlineRepository.queueAll())');
  });

  it('never deletes a queued financial write on network, auth, conflict, or permanent refusal', () => {
    const offline = read('client/src/offline.ts');
    const flush = offline.slice(offline.indexOf('async function runFlush('));
    expect(flush.match(/offlineRepository\.queueDrop\(item\.id\)/g)?.length).toBe(1);
    expect(flush.indexOf('await send(item.input);')).toBeLessThan(flush.indexOf('await offlineRepository.queueDrop(item.id);'));
    expect(flush).toContain("status: 'retry_wait'");
    expect(flush).toContain("status: 'blocked_auth'");
    expect(flush).toContain("status: 'conflict'");
    expect(flush).toContain("status: 'rejected'");
  });

  it('uses bounded exponential retries and an activation barrier before syncing', () => {
    const offline = read('client/src/offline.ts');
    expect(offline).toContain('const RETRY_BASE_MS = 2_000;');
    expect(offline).toContain('const RETRY_MAX_MS = 5 * 60_000;');
    expect(offline).toContain('Math.min(RETRY_MAX_MS');
    expect(offline).toContain('let syncActivation: Promise<void> = Promise.resolve();');
    const flush = offline.slice(offline.indexOf('async function runFlush('));
    expect(flush).toContain('await syncActivation;');
  });

  it('stops projected balances at the first server-blocked operation', () => {
    const projection = read('client/src/offline-projection.ts');
    const state = read('client/src/offline-sync-state.ts');
    expect(projection).toContain('offlineSyncState.projectablePrefix(queue)');
    expect(state).toContain("if (status === 'conflict' || status === 'rejected') break;");
  });

  it('passes one idempotency key through delegated handoff fallback, throttles writes, and creates it once server-side', () => {
    const api = read('client/src/api.ts');
    const server = read('server/offline-sync.ts');
    const start = read('server/start.ts');
    expect(api).toContain('clientRef: input.clientRef ?? null');
    expect(server).toContain("import { rateLimit } from 'express-rate-limit';");
    expect(server).toContain('const offlineWriteLimit = rateLimit({');
    expect(server).toContain("router.post('/delegation/transfers', offlineWriteLimit");
    expect(server).toContain('deterministicHandoffId(req.user.id, body.clientRef)');
    expect(server).toContain('ON CONFLICT (id) DO NOTHING');
    expect(server).toContain("code: 'IDEMPOTENCY_KEY_REUSED'");
    expect(server).toContain("'delegated transfer awaiting confirmation'");
    expect(server).toContain("'transfer_waiting'");
    expect(start).toContain('protectedSecurityRouter.use(offlineSyncRouter);');
  });

  it('keeps the real PostgreSQL replay certification in the integration gate', () => {
    const pkg = read('package.json');
    const test = read('server/offline-sync.integration.test.ts');
    expect(pkg).toContain('server/offline-sync.integration.test.ts');
    expect(test).toContain('Promise.all([');
    expect(test).toContain("count(*) AS n FROM pending_transfers WHERE id = $1");
    expect(test).toContain("count(*) AS n FROM entries WHERE client_ref = $1");
  });
});

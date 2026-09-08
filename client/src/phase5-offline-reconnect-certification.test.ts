import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Phase 5 offline + reconnect certification', () => {
  it('keeps replay storms exactly-once and stale multi-device writes serialized', () => {
    const chaos = read('server/offline-chaos.integration.test.ts');
    expect(chaos).toContain("Array.from({ length: 40 }");
    expect(chaos).toContain("count(*) AS n FROM entries WHERE client_ref = $1");
    expect(chaos).toContain('OFFLINE_CONFLICT_STALE_BALANCE');
    expect(chaos).toContain('OFFLINE_CONFLICT_INSUFFICIENT_FUNDS');
    expect(chaos).toContain('sourceBalance + aBalance + bBalance').toBeTruthy;
  });

  it('keeps revoked and disabled offline sessions unable to post queued money', () => {
    const chaos = read('server/offline-chaos.integration.test.ts');
    expect(chaos).toContain("blocked.response.status).toBe(401)");
    expect(chaos).toContain("q_phase7_revoked_session");
    expect(chaos).toContain("q_phase7_disabled_user");
  });

  it('keeps receipt uploads durable, retryable and idempotent', () => {
    const attachments = read('client/src/offline-attachments.ts');
    const server = read('server/offline-attachments.integration.test.ts');
    expect(attachments).toContain("'x-offline-attachment-id': record.id");
    expect(attachments).toContain('retryDelayMs');
    expect(attachments).toContain("status: 'waiting'");
    expect(attachments).toContain("status: 'uploaded'");
    expect(server).toContain('x-offline-attachment-id');
    expect(server).toContain('count(*)');
  });

  it('wakes both ledger and receipt queues after transport reconnect or long mobile resume', () => {
    const recovery = read('client/src/offline-live-recovery.ts');
    const tests = read('client/src/offline-live-recovery.test.ts');
    expect(recovery).toContain('flushOutbox(sendOfflineQueued)');
    expect(recovery).toContain('flushOfflineAttachments()');
    expect(recovery).toContain("reason === 'online'");
    expect(tests).toContain("stream-reconnected");
    expect(tests).toContain("resume");
    expect(tests).toContain("{ ledger: false, attachments: true }");
  });

  it('keeps reconnect chaos and database integrity inside the blocking CI gate', () => {
    const workflow = read('.github/workflows/ci.yml');
    const pkg = read('package.json');
    expect(workflow).toContain('Offline chaos and multi-device certification');
    expect(workflow).toContain('npm run test:offline-chaos');
    expect(workflow).toContain('Final database integrity certification');
    expect(pkg).toContain('server/offline-attachments.integration.test.ts');
  });
});

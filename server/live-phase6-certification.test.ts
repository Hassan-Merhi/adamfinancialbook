import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const startSource = readFileSync(new URL('./start.ts', import.meta.url), 'utf8');
const liveSource = readFileSync(new URL('./live-updates.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../client/src/main.tsx', import.meta.url), 'utf8');
const quarantineSource = readFileSync(new URL('../client/src/session-quarantine.ts', import.meta.url), 'utf8');

describe('Phase 6 live security certification contract', () => {
  it('observes mutations and session revocations before protected security routes can finish', () => {
    const telemetry = startSource.indexOf('publicSecurityRouter.use(requestTelemetry)');
    const mutation = startSource.indexOf('publicSecurityRouter.use(liveMutationObserver)');
    const security = startSource.indexOf('publicSecurityRouter.use(liveSecuritySessionObserver)');
    const protectedStream = startSource.indexOf('protectedSecurityRouter.use(liveUpdatesRouter)');

    expect(telemetry).toBeGreaterThanOrEqual(0);
    expect(mutation).toBeGreaterThan(telemetry);
    expect(security).toBeGreaterThan(mutation);
    expect(protectedStream).toBeGreaterThan(security);
    expect(startSource).not.toContain('protectedSecurityRouter.use(liveMutationObserver)');
  });

  it('keeps the SSE endpoint authenticated while binding each stream to its durable security session', () => {
    expect(startSource).toContain('protectedSecurityRouter.use(liveUpdatesRouter)');
    expect(liveSource).toContain('securitySessionId: req.securitySession?.id ?? null');
  });

  it('uses PostgreSQL fanout for session control instead of periodic authorization polling', () => {
    expect(liveSource).toContain("kind: 'session-control'");
    expect(liveSource).toContain("SELECT pg_notify($1, $2)");
    expect(liveSource).not.toContain('setInterval(async');
    expect(liveSource).not.toContain('validateSecuritySession(');
  });

  it('never sends revocation reasons, user ids, or session ids in the browser session event', () => {
    const eventLine = "JSON.stringify({ state: 'refresh', at: control.at })";
    expect(liveSource).toContain(eventLine);
    expect(liveSource).not.toContain("event: session\\ndata: ${JSON.stringify(control)}");
  });

  it('installs protected-401 quarantine only after durable offline storage is initialized', () => {
    const initialize = mainSource.indexOf('await initializeOfflineStorage()');
    const quarantine = mainSource.indexOf('installSessionQuarantine()');
    expect(initialize).toBeGreaterThanOrEqual(0);
    expect(quarantine).toBeGreaterThan(initialize);
    expect(quarantineSource).toContain('await lastUser.clear()');
    expect(quarantineSource).toContain('preserves');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Render Phase 1 production health/proxy contract', () => {
  it('trusts exactly one Render reverse-proxy hop before API rate limiting', () => {
    const server = read('server/index.ts');
    const trustProxy = server.indexOf("app.set('trust proxy', 1)");
    const limiter = server.indexOf("app.use('/api', rateLimit({");

    expect(trustProxy).toBeGreaterThan(-1);
    expect(limiter).toBeGreaterThan(-1);
    expect(trustProxy).toBeLessThan(limiter);
    expect(server).not.toContain("app.set('trust proxy', true)");
  });

  it('keeps readiness public and database/migration aware', () => {
    const health = read('server/health.ts');
    const start = read('server/start.ts');

    expect(health).toContain("healthRouter.get('/health/ready'");
    expect(health).toContain('res.status(state.ok ? 200 : 503)');
    expect(health).toContain('database: state.database');
    expect(health).toContain('pendingMigrations: state.pendingMigrations');
    expect(start).toContain('publicSecurityRouter.use(healthRouter)');
  });

  it('keeps the production blueprint health check on the readiness endpoint', () => {
    const render = read('render.yaml');
    expect(render).toContain('healthCheckPath: /api/health/ready');
  });
});

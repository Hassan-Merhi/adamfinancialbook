import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearGitHubOidcJwksCacheForTests,
  verifyGitHubActionsOidcToken,
} from './github-actions-oidc.js';

const repository = 'Hassan-Merhi/adamfinancialbook';
const workflowRef = `${repository}/.github/workflows/encrypted-production-backup.yml@refs/heads/main`;

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  Object.assign(jwk, { kid: 'phase2-test-key', alg: 'RS256', use: 'sig' });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ keys: [jwk] }),
  })));
  return { privateKey };
}

function token(privateKey: ReturnType<typeof fixture>['privateKey'], overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'RS256', kid: 'phase2-test-key', typ: 'JWT' });
  const payload = encode({
    iss: 'https://token.actions.githubusercontent.com',
    aud: 'adam-financial-book-backup',
    exp: now + 300,
    nbf: now - 5,
    iat: now - 5,
    sub: `repo:${repository}:ref:refs/heads/main`,
    repository,
    repository_id: '1342187497',
    ref: 'refs/heads/main',
    sha: 'abc123',
    workflow_ref: workflowRef,
    event_name: 'workflow_dispatch',
    runner_environment: 'github-hosted',
    run_id: '42',
    run_attempt: '1',
    ...overrides,
  });
  const input = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(privateKey).toString('base64url')}`;
}

afterEach(() => {
  clearGitHubOidcJwksCacheForTests();
  vi.unstubAllGlobals();
});

describe('GitHub Actions OIDC backup identity', () => {
  it('accepts only the exact signed main workflow release', async () => {
    const { privateKey } = fixture();
    const claims = await verifyGitHubActionsOidcToken(token(privateKey), 'abc123');
    expect(claims.repository).toBe(repository);
    expect(claims.sha).toBe('abc123');
  });

  it('rejects a token from another repository even with a valid signature', async () => {
    const { privateKey } = fixture();
    await expect(verifyGitHubActionsOidcToken(token(privateKey, {
      repository: 'someone/else',
    }), 'abc123')).rejects.toThrow(/repository identity/i);
  });

  it('rejects a valid workflow token for a different deployed release', async () => {
    const { privateKey } = fixture();
    await expect(verifyGitHubActionsOidcToken(token(privateKey), 'different-sha'))
      .rejects.toThrow(/does not match the deployed production release/i);
  });

  it('rejects expired identities', async () => {
    const { privateKey } = fixture();
    const now = Math.floor(Date.now() / 1000);
    await expect(verifyGitHubActionsOidcToken(token(privateKey, { exp: now - 120 }), 'abc123'))
      .rejects.toThrow(/expired/i);
  });
});

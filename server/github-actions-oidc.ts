import { createPublicKey, createVerify } from 'node:crypto';

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const AUDIENCE = 'adam-financial-book-backup';
const REPOSITORY = 'Hassan-Merhi/adamfinancialbook';
const REPOSITORY_ID = '1342187497';
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/encrypted-production-backup.yml@refs/heads/main`;
const SUBJECT = `repo:${REPOSITORY}:ref:refs/heads/main`;
const ALLOWED_EVENTS = new Set(['schedule', 'workflow_dispatch', 'push']);
const MAX_TOKEN_BYTES = 16 * 1024;

type JsonWebKeyRecord = Record<string, unknown> & {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
};

type GitHubOidcClaims = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  sub?: string;
  repository?: string;
  repository_id?: string;
  ref?: string;
  sha?: string;
  workflow_ref?: string;
  event_name?: string;
  runner_environment?: string;
  run_id?: string;
  run_attempt?: string;
};

let jwksCache: { loadedAt: number; keys: JsonWebKeyRecord[] } | null = null;

function decodeJson(segment: string) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('GitHub OIDC token is not valid JWT JSON.');
  }
}

function audienceMatches(aud: string | string[] | undefined) {
  return Array.isArray(aud) ? aud.includes(AUDIENCE) : aud === AUDIENCE;
}

async function loadJwks(force = false) {
  const now = Date.now();
  if (!force && jwksCache && now - jwksCache.loadedAt < 10 * 60_000) return jwksCache.keys;
  const response = await fetch(JWKS_URL, {
    headers: { Accept: 'application/json', 'User-Agent': 'adam-financial-book' },
  });
  if (!response.ok) throw new Error(`GitHub OIDC JWKS returned HTTP ${response.status}.`);
  const payload = await response.json() as { keys?: JsonWebKeyRecord[] };
  if (!Array.isArray(payload.keys) || !payload.keys.length) {
    throw new Error('GitHub OIDC JWKS did not contain signing keys.');
  }
  jwksCache = { loadedAt: now, keys: payload.keys };
  return payload.keys;
}

async function signingKey(kid: string) {
  let keys = await loadJwks();
  let key = keys.find((item) => item.kid === kid);
  if (!key) {
    keys = await loadJwks(true);
    key = keys.find((item) => item.kid === kid);
  }
  if (!key) throw new Error('GitHub OIDC signing key was not found.');
  if (key.kty !== 'RSA') throw new Error('GitHub OIDC signing key must be RSA.');
  if (key.alg && key.alg !== 'RS256') throw new Error('GitHub OIDC signing key algorithm is not RS256.');
  return createPublicKey({ key: key as never, format: 'jwk' });
}

function validateClaims(claims: GitHubOidcClaims, expectedRelease: string) {
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER) throw new Error('GitHub OIDC issuer is invalid.');
  if (!audienceMatches(claims.aud)) throw new Error('GitHub OIDC audience is invalid.');
  if (!claims.exp || claims.exp < now - 30) throw new Error('GitHub OIDC token has expired.');
  if (claims.nbf && claims.nbf > now + 30) throw new Error('GitHub OIDC token is not active yet.');
  if (claims.iat && claims.iat > now + 30) throw new Error('GitHub OIDC issued-at time is invalid.');
  if (claims.repository !== REPOSITORY || claims.repository_id !== REPOSITORY_ID) {
    throw new Error('GitHub OIDC repository identity is invalid.');
  }
  if (claims.ref !== 'refs/heads/main' || claims.sub !== SUBJECT) {
    throw new Error('GitHub OIDC ref identity is invalid.');
  }
  if (claims.workflow_ref !== WORKFLOW_REF) throw new Error('GitHub OIDC workflow identity is invalid.');
  if (!claims.event_name || !ALLOWED_EVENTS.has(claims.event_name)) {
    throw new Error('GitHub OIDC event is not allowed to export backups.');
  }
  if (claims.runner_environment !== 'github-hosted') {
    throw new Error('GitHub OIDC runner environment is invalid.');
  }
  if (!claims.sha || claims.sha !== expectedRelease) {
    throw new Error('GitHub OIDC workflow SHA does not match the deployed production release.');
  }
}

export async function verifyGitHubActionsOidcToken(token: string, expectedRelease: string) {
  if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
    throw new Error('GitHub OIDC bearer token is too large.');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error('GitHub OIDC bearer token is not a JWT.');
  }

  // Only the JOSE header is read before authentication so we can select the
  // advertised signing key. The claims payload remains opaque until the RSA
  // signature over header.payload has been verified with GitHub's JWKS key.
  const header = decodeJson(parts[0]) as { alg?: string; kid?: string; typ?: string };
  if (header.alg !== 'RS256' || !header.kid) throw new Error('GitHub OIDC JWT header is invalid.');
  if (header.typ && header.typ !== 'JWT') throw new Error('GitHub OIDC JWT type is invalid.');

  const key = await signingKey(header.kid);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`, 'utf8');
  verifier.end();
  const signature = Buffer.from(parts[2], 'base64url');
  if (!signature.length || !verifier.verify(key, signature)) {
    throw new Error('GitHub OIDC JWT signature is invalid.');
  }

  // Decode and trust claims only after cryptographic authentication succeeds.
  const claims = decodeJson(parts[1]) as GitHubOidcClaims;
  validateClaims(claims, expectedRelease);
  return claims;
}

export function clearGitHubOidcJwksCacheForTests() {
  jwksCache = null;
}

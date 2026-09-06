import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { createEncryptedDatabaseBackup } from './backup-service.js';
import { markBackupOffsiteDelivered } from './backup-delivery.js';
import { logOperationalEvent } from './alerts.js';
import { verifyGitHubActionsOidcToken } from './github-actions-oidc.js';

const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MAX_AUTHORIZATION_BYTES = 20 * 1024;
const MAX_BEARER_BYTES = 16 * 1024;

export function bearerTokenFromAuthorization(authorization: string | undefined): string {
  const value = authorization ?? '';
  if (
    value.length < 8
    || Buffer.byteLength(value, 'utf8') > MAX_AUTHORIZATION_BYTES
    || value.slice(0, 7).toLowerCase() !== 'bearer '
  ) {
    throw Object.assign(new Error('GitHub Actions OIDC bearer token is required.'), { status: 401 });
  }
  const token = value.slice(7);
  if (
    !token
    || Buffer.byteLength(token, 'utf8') > MAX_BEARER_BYTES
    || token.includes(' ')
    || token.includes('\t')
    || token.includes('\r')
    || token.includes('\n')
  ) {
    throw Object.assign(new Error('GitHub Actions OIDC bearer token is invalid.'), { status: 401 });
  }
  return token;
}

function bearer(req: Parameters<RequestHandler>[0]) {
  return bearerTokenFromAuthorization(req.get('authorization'));
}

function productionRelease() {
  const release = process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT;
  if (!release || release === 'local') {
    throw Object.assign(new Error('Backup export requires a concrete production release SHA.'), { status: 503 });
  }
  return release;
}

async function authenticate(req: Parameters<RequestHandler>[0]) {
  const release = productionRelease();
  const token = bearer(req);
  try {
    const claims = await verifyGitHubActionsOidcToken(token, release);
    return { release, claims };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GitHub Actions OIDC verification failed.';
    throw Object.assign(new Error(message), { status: 403 });
  }
}

const deliveryInput = z.object({
  backupId: z.string().min(1).max(120),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
  artifactId: z.string().min(1).max(120),
  artifactDigest: z.string().min(1).max(160),
  artifactUrl: z.string().url().max(1000),
  retentionUntil: z.string().datetime(),
});

// These machine endpoints sit outside cookie authentication by design, so keep
// a route-local limiter in addition to the app-wide API limiter. Four retry
// attempts per minute are expected while a newly merged production release is
// rolling out; 12/minute leaves headroom without allowing an authenticated
// workflow identity to generate backups without bound.
const backupMachineLimiter = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

export const backupExportRouter = Router();

backupExportRouter.post('/operations/backups/export', backupMachineLimiter, wrap(async (req, res) => {
  const { release, claims } = await authenticate(req);
  const artifact = await createEncryptedDatabaseBackup('github-actions-export');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`);
  res.setHeader('Content-Length', String(artifact.bytes));
  res.setHeader('X-AFB-Filename', artifact.filename);
  res.setHeader('X-AFB-Backup-Id', artifact.id);
  res.setHeader('X-AFB-Sha256', artifact.checksum);
  res.setHeader('X-AFB-Release', release);
  res.setHeader('X-AFB-Migration', String(artifact.migrationVersion ?? 'unknown'));
  logOperationalEvent('backup.offsite.exported', {
    id: artifact.id,
    release,
    runId: claims.run_id ?? null,
    runAttempt: claims.run_attempt ?? null,
    bytes: artifact.bytes,
  });
  res.send(artifact.buffer);
}));

backupExportRouter.post('/operations/backups/ack', backupMachineLimiter, wrap(async (req, res) => {
  const { release, claims } = await authenticate(req);
  const body = deliveryInput.parse(req.body);
  const retentionUntil = new Date(body.retentionUntil);
  const now = Date.now();
  const remainingDays = (retentionUntil.getTime() - now) / 86_400_000;
  if (remainingDays < 30 || remainingDays > 100) {
    return res.status(400).json({ error: 'Backup retention must be between 30 and 100 days.' });
  }
  await markBackupOffsiteDelivered(body.backupId, {
    checksum: body.checksum,
    bytes: body.bytes,
    deliveryRef: body.artifactUrl,
    artifactDigest: body.artifactDigest,
    retentionUntil: retentionUntil.toISOString(),
  });
  logOperationalEvent('backup.offsite.acknowledged', {
    id: body.backupId,
    release,
    runId: claims.run_id ?? null,
    artifactId: body.artifactId,
    retentionUntil: retentionUntil.toISOString(),
  });
  res.json({ ok: true, backupId: body.backupId, release });
}));

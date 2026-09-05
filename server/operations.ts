import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { ownerOnly } from './auth.js';
import { createEncryptedDatabaseBackup } from './backup-service.js';
import { operationsStatus, recentOperationalEvents } from './observability.js';
import { record } from './audit.js';

const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const operationsRouter = Router();
operationsRouter.use(ownerOnly);

operationsRouter.get('/operations/status', wrap(async (_req, res) => {
  res.json(await operationsStatus());
}));

operationsRouter.get('/operations/events', wrap(async (req, res) => {
  const limit = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit);
  res.json({ events: await recentOperationalEvents(limit) });
}));

operationsRouter.post('/operations/backup', wrap(async (req, res) => {
  const artifact = await createEncryptedDatabaseBackup('owner-download');
  await record(req, 'encrypted backup taken', artifact.id, {
    bytes: artifact.bytes,
    checksum: artifact.checksum,
    migrationVersion: artifact.migrationVersion,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`);
  res.setHeader('X-Backup-Sha256', artifact.checksum);
  res.setHeader('X-Backup-Id', artifact.id);
  res.send(artifact.buffer);
}));

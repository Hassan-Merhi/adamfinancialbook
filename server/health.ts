import { Router, type RequestHandler } from 'express';
import { readiness } from './readiness.js';

const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const healthRouter = Router();

healthRouter.get('/health/live', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});

healthRouter.get('/health/ready', wrap(async (_req, res) => {
  const state = await readiness();
  res.setHeader('Cache-Control', 'no-store');
  res.status(state.ok ? 200 : 503).json({
    ok: state.ok,
    release: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? 'unknown',
    database: state.database,
    migrations: state.migrations,
    pendingMigrations: state.pendingMigrations,
    currentMigration: state.currentMigration,
    latestMigration: state.latestMigration,
    backups: state.backups,
    latestBackupAt: state.latestBackupAt,
    backupAgeHours: state.backupAgeHours,
    ...(state.detail ? { detail: state.detail } : {}),
  });
}));

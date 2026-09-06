import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ownerOnly, verifyPassword } from './auth.js';
import { pool } from './db.js';
import { hasRecentAuthentication } from './security.js';
import { RESET_CONFIRMATIONS, RESET_LABELS, type ResetScope } from '../shared/reset.js';

const router = Router();

const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Password verification is intentionally rate-limited per authenticated owner.
// Only failed requests consume the allowance, so a legitimate successful reset
// does not lock the owner out of later maintenance work.
const resetAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => req.user!.id,
  message: { error: 'Too many failed reset attempts. Try again in 15 minutes.' },
});

const recentRequired: RequestHandler = wrap(async (req, res, next) => {
  if (!(await hasRecentAuthentication(req.securitySession?.id))) {
    return res.status(403).json({
      error: 'Unlock security changes with your current password first.',
      code: 'reauth_required',
    });
  }
  next();
});

export interface ResetPreview {
  businesses: number;
  accounts: number;
  projects: number;
  people: number;
  entries: number;
  reminders: number;
  approvals: number;
  pendingTransfers: number;
  attachments: number;
  delegatedAccounts: number;
  notifications: number;
  auditLines: number;
  otherUsers: number;
}

type QueryFn = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

async function previewWith(queryFn: QueryFn, actorId: string): Promise<ResetPreview> {
  const result = await queryFn(`
    SELECT
      (SELECT COUNT(*)::int FROM businesses) AS businesses,
      (SELECT COUNT(*)::int FROM accounts) AS accounts,
      (SELECT COUNT(*)::int FROM projects) AS projects,
      (SELECT COUNT(*)::int FROM people) AS people,
      (SELECT COUNT(*)::int FROM entries) AS entries,
      (SELECT COUNT(*)::int FROM reminders) AS reminders,
      (SELECT COUNT(*)::int FROM approval_requests) AS approvals,
      (SELECT COUNT(*)::int FROM pending_transfers) AS pending_transfers,
      (SELECT COUNT(*)::int FROM attachments) AS attachments,
      (SELECT COUNT(*)::int FROM user_accounts) AS delegated_accounts,
      (SELECT COUNT(*)::int FROM notifications) AS notifications,
      (SELECT COUNT(*)::int FROM audit) AS audit_lines,
      (SELECT COUNT(*)::int FROM users WHERE id <> $1) AS other_users
  `, [actorId]);
  const row = result.rows[0] ?? {};
  return {
    businesses: Number(row.businesses ?? 0),
    accounts: Number(row.accounts ?? 0),
    projects: Number(row.projects ?? 0),
    people: Number(row.people ?? 0),
    entries: Number(row.entries ?? 0),
    reminders: Number(row.reminders ?? 0),
    approvals: Number(row.approvals ?? 0),
    pendingTransfers: Number(row.pending_transfers ?? 0),
    attachments: Number(row.attachments ?? 0),
    delegatedAccounts: Number(row.delegated_accounts ?? 0),
    notifications: Number(row.notifications ?? 0),
    auditLines: Number(row.audit_lines ?? 0),
    otherUsers: Number(row.other_users ?? 0),
  };
}

export async function resetPreview(actorId: string): Promise<ResetPreview> {
  return previewWith((text, params) => pool.query(text, params), actorId);
}

async function clearActivity(client: PoolClient): Promise<void> {
  // Opening project receipts have no entry_id. Capture only activity-linked
  // receipt ids before unlinking the two-way entry/receipt relationship so the
  // opening project balances survive this reset level.
  await client.query(`
    CREATE TEMP TABLE reset_activity_receipts ON COMMIT DROP AS
    SELECT id FROM project_receipts WHERE entry_id IS NOT NULL
  `);

  // Newer accounting-integrity tables must be cleared before their entries.
  await client.query('DELETE FROM attachments');
  await client.query('DELETE FROM entry_revisions');
  await client.query('DELETE FROM effects');
  await client.query('DELETE FROM notifications');
  await client.query('DELETE FROM approval_requests');
  await client.query('DELETE FROM pending_transfers');

  await client.query('UPDATE entries SET link_receipt_id = NULL WHERE link_receipt_id IS NOT NULL');
  await client.query(`
    UPDATE project_receipts
       SET entry_id = NULL
     WHERE id IN (SELECT id FROM reset_activity_receipts)
  `);
  await client.query('DELETE FROM entries');
  await client.query('DELETE FROM project_receipts WHERE id IN (SELECT id FROM reset_activity_receipts)');
  await client.query('DELETE FROM reminders');
  await client.query('DELETE FROM audit');
}

async function clearBook(client: PoolClient): Promise<void> {
  await clearActivity(client);
  await client.query('DELETE FROM project_receipts');
  await client.query('DELETE FROM user_accounts');
  await client.query('DELETE FROM loans');
  await client.query('DELETE FROM people');
  await client.query('DELETE FROM projects');
  await client.query('DELETE FROM accounts');
  await client.query('DELETE FROM businesses');
}

export async function performReset(
  scope: ResetScope,
  actorId: string,
  actorEmail = '',
): Promise<ResetPreview> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await previewWith((text, params) => client.query(text, params), actorId);

    if (scope === 'activity') {
      await clearActivity(client);
    } else {
      await clearBook(client);
      if (scope === 'everything') {
        // Never delete the owner who is performing the reset. Keeping one valid
        // owner prevents a factory reset from turning into a lockout. The local
        // transaction flag is required by the database delete guard.
        await client.query("SELECT set_config('app.allow_user_delete','true',true)");
        await client.query('DELETE FROM users WHERE id <> $1', [actorId]);
      }
    }

    // The wipe and its audit line are one atomic operation. If this insert ever
    // fails, the reset rolls back too; the browser will never be told a reset
    // failed after the destructive part already committed.
    await client.query(
      `INSERT INTO audit (actor, actor_email, action, detail)
       VALUES ($1,$2,'book reset',$3::jsonb)`,
      [actorId, actorEmail || null, JSON.stringify({ scope, label: RESET_LABELS[scope], deleted: before })],
    );

    await client.query('COMMIT');
    return before;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

router.get('/reset/preview', ownerOnly, wrap(async (req, res) => {
  res.json({ counts: await resetPreview(req.user!.id) });
}));

router.post('/reset', ownerOnly, resetAttemptLimiter, wrap(async (req, res) => {
  const body = z.object({
    scope: z.enum(['activity', 'book', 'everything']),
    password: z.string().min(1).max(300),
    confirmation: z.string().max(80),
  }).parse(req.body);

  if (body.confirmation !== RESET_CONFIRMATIONS[body.scope]) {
    return res.status(400).json({
      error: `Type ${RESET_CONFIRMATIONS[body.scope]} exactly to confirm this reset.`,
    });
  }
  if (!(await verifyPassword(req.user!.id, body.password))) {
    return res.status(403).json({ error: 'Your current password is incorrect.' });
  }

  const deleted = await performReset(body.scope, req.user!.id, req.user!.email);
  res.json({ ok: true, scope: body.scope, deleted });
}));

// A user must be disabled before their login can be permanently deleted. This
// keeps accidental taps from immediately erasing credentials while still giving
// the owner the lifecycle requested by the UI: disable first, then delete.
// Accounting/evidence rows survive because migration 007 converts user FKs that
// carry history to ON DELETE SET NULL; access-only/session rows are cascaded.
router.delete('/users/:id/permanent', ownerOnly, recentRequired, wrap(async (req, res) => {
  const targetId = String(req.params.id);
  if (targetId === req.user!.id) {
    return res.status(400).json({ error: 'You cannot permanently delete your own login.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string; email: string; role: string; active: boolean }>(
      'SELECT id, email, role, active FROM users WHERE id = $1 FOR UPDATE',
      [targetId],
    );
    const target = result.rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No user with that id.' });
    }
    if (target.active) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Disable this user first, then you can permanently delete them.' });
    }

    await client.query("SELECT set_config('app.allow_user_delete','true',true)");
    await client.query('DELETE FROM users WHERE id = $1', [target.id]);
    await client.query(
      `INSERT INTO audit (actor, actor_email, action, subject, detail)
       VALUES ($1,$2,'user permanently deleted',$3,$4::jsonb)`,
      [
        req.user!.id,
        req.user!.email,
        target.id,
        JSON.stringify({ username: target.email, role: target.role }),
      ],
    );
    await client.query('COMMIT');
    res.json({ ok: true, deleted: { id: target.id, username: target.email } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

export const resetRouter = router;

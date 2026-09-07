import { Router } from 'express';
import { z } from 'zod';
import { ownerOnly } from './auth.js';
import { query } from './db.js';
import { record } from './audit.js';

export const accountManagementRouter = Router();

const accountEdit = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  opening: z.number().finite().optional(),
}).refine((body) => body.name !== undefined || body.opening !== undefined, {
  message: 'Change the account name or opening balance.',
});

accountManagementRouter.patch('/accounts/:id', ownerOnly, async (req, res) => {
  const id = String(req.params.id);
  const body = accountEdit.parse(req.body);
  const before = await query<{ id: string; name: string; opening: string | number }>(
    'SELECT id, name, opening FROM accounts WHERE id = $1',
    [id],
  );
  const current = before[0];
  if (!current) return res.status(404).json({ error: 'No such account.' });

  const updated = await query<{ id: string; name: string; business_id: string | null; opening: string | number }>(
    `UPDATE accounts
        SET name = COALESCE($2, name),
            opening = COALESCE($3::numeric, opening)
      WHERE id = $1
      RETURNING id, name, business_id, opening`,
    [id, body.name ?? null, body.opening ?? null],
  );

  await record(req, 'account updated', id, {
    name: { from: current.name, to: updated[0].name },
    opening: { from: Number(current.opening), to: Number(updated[0].opening) },
  });
  res.json({
    id: updated[0].id,
    name: updated[0].name,
    businessId: updated[0].business_id,
    opening: Number(updated[0].opening),
  });
});

accountManagementRouter.delete('/accounts/:id', ownerOnly, async (req, res) => {
  const id = String(req.params.id);
  const rows = await query<{ id: string; name: string; opening: string | number }>(
    'SELECT id, name, opening FROM accounts WHERE id = $1',
    [id],
  );
  const account = rows[0];
  if (!account) return res.status(404).json({ error: 'No such account.' });

  const usage = await query<{ used: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM entries WHERE account_id = $1 OR to_account_id = $1)
       OR EXISTS (SELECT 1 FROM effects WHERE type = 'account' AND target_id = $1)
       OR EXISTS (SELECT 1 FROM reminders WHERE account_id = $1)
       OR EXISTS (SELECT 1 FROM user_accounts WHERE account_id = $1)
       OR EXISTS (SELECT 1 FROM pending_transfers WHERE from_account_id = $1 OR to_account_id = $1)
       OR EXISTS (SELECT 1 FROM approval_requests WHERE account_id = $1)
     ) AS used`,
    [id],
  );

  if (usage[0]?.used) {
    return res.status(409).json({
      error: 'This account already has activity or is assigned somewhere, so deleting it would damage the ledger. Remove those links or keep the account for history.',
      code: 'ACCOUNT_IN_USE',
    });
  }

  await query('DELETE FROM accounts WHERE id = $1', [id]);
  await record(req, 'account deleted', id, { name: account.name, opening: Number(account.opening) });
  res.json({ ok: true });
});

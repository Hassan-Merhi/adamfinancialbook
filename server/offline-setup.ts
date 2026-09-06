/** Exactly-once offline creation for safe, non-destructive setup records. */
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, query } from './db.js';
import { recordRequired } from './audit.js';
import { ensureLoanPair } from './book.js';
import { offlineSetupEntityId, offlineSetupReceiptId, type OfflineSetupInput } from '../shared/offline-setup.js';

export const offlineSetupRouter = Router();

class SetupConflict extends Error {
  constructor(message: string, readonly code: 'OFFLINE_CONFLICT_IDEMPOTENCY_KEY_REUSED' | 'OFFLINE_CONFLICT_TARGET_MISSING') {
    super(message);
  }
}

const marker = {
  offlineOperation: z.literal('setup_create'),
  clientRef: z.string().min(1).max(80),
};
const businessSchema = z.object({ ...marker, setupType: z.literal('business'), name: z.string().trim().min(1).max(80) });
const accountSchema = z.object({ ...marker, setupType: z.literal('account'), name: z.string().trim().min(1).max(80), businessId: z.string().nullish(), opening: z.number().default(0) });
const projectSchema = z.object({ ...marker, setupType: z.literal('project'), name: z.string().trim().min(1).max(80), businessId: z.string().min(1), opening: z.number().default(0), scope: z.string().max(200).default('') });
const personSchema = z.object({ ...marker, setupType: z.literal('person'), name: z.string().trim().min(1).max(80), businessId: z.string().min(1), kind: z.enum(['receivable', 'payable', 'salary']), opening: z.number().default(0), salary: z.number().default(0), role: z.string().max(120).default('') });
const reminderSchema = z.object({ ...marker, setupType: z.literal('reminder'), what: z.string().trim().min(1).max(120), amount: z.number().default(0), accountId: z.string().nullish(), note: z.string().max(500).default('') });

function offlineOwner(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.body?.offlineOperation !== 'setup_create') return next();
    if (req.user?.role !== 'owner') {
      res.status(403).json({ error: 'Only you can change that — ask the owner.' });
      return;
    }
    void handler(req, res).catch((error) => {
      if (error instanceof SetupConflict) {
        res.status(409).json({ error: error.message, code: error.code });
        return;
      }
      next(error);
    });
  };
}

async function locked<T>(userId: string, clientRef: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`offline-setup:${userId}:${clientRef}`]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function reused(): never {
  throw new SetupConflict('That offline setup reference was already used for different data. Review the stored change before retrying.', 'OFFLINE_CONFLICT_IDEMPOTENCY_KEY_REUSED');
}

async function requireParent(client: PoolClient, table: 'businesses' | 'accounts', id: string): Promise<void> {
  const found = await client.query(`SELECT id FROM ${table} WHERE id = $1`, [id]);
  if (!found.rowCount) {
    throw new SetupConflict('A setup item this change depends on is not on the server yet.', 'OFFLINE_CONFLICT_TARGET_MISSING');
  }
}

function sameNumber(a: unknown, b: number): boolean {
  return Math.abs(Number(a) - Number(b)) < 0.000001;
}

async function auditSetup(client: PoolClient, type: string, id: string, body: OfflineSetupInput): Promise<void> {
  await recordRequired(client, `offline setup ${type} created`, id, {
    clientRef: body.clientRef ?? null,
    setupType: body.setupType,
  });
}

offlineSetupRouter.post('/businesses', offlineOwner(async (req, res) => {
  const body = businessSchema.parse(req.body) as OfflineSetupInput & { setupType: 'business'; name: string; clientRef: string };
  const id = offlineSetupEntityId(body);
  const created = await locked(req.user!.id, body.clientRef, async (client) => {
    const existing = await client.query<{ name: string }>('SELECT name FROM businesses WHERE id = $1', [id]);
    if (existing.rows[0]) {
      if (existing.rows[0].name !== body.name) reused();
      return false;
    }
    await client.query('INSERT INTO businesses (id, name) VALUES ($1,$2)', [id, body.name]);
    await auditSetup(client, 'business', id, body);
    return true;
  });
  // Re-run this idempotent repair on replay too. If the first response was lost,
  // every canonical inter-business loan pair still converges before acknowledgement.
  const others = await query<{ id: string }>('SELECT id FROM businesses WHERE id <> $1', [id]);
  for (const other of others) await ensureLoanPair(id, other.id);
  res.status(created ? 201 : 200).json({ id, name: body.name, clientRef: body.clientRef, created });
}));

offlineSetupRouter.post('/accounts', offlineOwner(async (req, res) => {
  const body = accountSchema.parse(req.body) as OfflineSetupInput & { setupType: 'account'; name: string; businessId: string | null; opening: number; clientRef: string };
  const id = offlineSetupEntityId(body);
  const created = await locked(req.user!.id, body.clientRef, async (client) => {
    if (body.businessId) await requireParent(client, 'businesses', body.businessId);
    const existing = await client.query<{ name: string; business_id: string | null; opening: number }>('SELECT name, business_id, opening FROM accounts WHERE id = $1', [id]);
    const row = existing.rows[0];
    if (row) {
      if (row.name !== body.name || row.business_id !== (body.businessId ?? null) || !sameNumber(row.opening, body.opening)) reused();
      return false;
    }
    await client.query('INSERT INTO accounts (id, name, business_id, opening) VALUES ($1,$2,$3,$4)', [id, body.name, body.businessId ?? null, body.opening]);
    await auditSetup(client, 'account', id, body);
    return true;
  });
  res.status(created ? 201 : 200).json({ id, ...body, created });
}));

offlineSetupRouter.post('/projects', offlineOwner(async (req, res) => {
  const body = projectSchema.parse(req.body) as OfflineSetupInput & { setupType: 'project'; name: string; businessId: string; opening: number; scope: string; clientRef: string };
  const id = offlineSetupEntityId(body);
  const receiptId = offlineSetupReceiptId(body.clientRef);
  const created = await locked(req.user!.id, body.clientRef, async (client) => {
    await requireParent(client, 'businesses', body.businessId);
    const existing = await client.query<{ name: string; business_id: string; scope: string }>('SELECT name, business_id, scope FROM projects WHERE id = $1', [id]);
    const row = existing.rows[0];
    if (row) {
      const receipt = await client.query<{ amount: number }>('SELECT amount FROM project_receipts WHERE id = $1 AND voided_at IS NULL', [receiptId]);
      const openingMatches = body.opening > 0 ? !!receipt.rows[0] && sameNumber(receipt.rows[0].amount, body.opening) : !receipt.rows[0];
      if (row.name !== body.name || row.business_id !== body.businessId || row.scope !== body.scope || !openingMatches) reused();
      return false;
    }
    await client.query('INSERT INTO projects (id, name, scope, business_id) VALUES ($1,$2,$3,$4)', [id, body.name, body.scope, body.businessId]);
    if (body.opening > 0) {
      await client.query(`INSERT INTO project_receipts (id, project_id, occurred_on, amount, in_cash, entry_id) VALUES ($1,$2,NULL,$3,true,NULL)`, [receiptId, id, body.opening]);
    }
    await auditSetup(client, 'project', id, body);
    return true;
  });
  res.status(created ? 201 : 200).json({ id, ...body, created });
}));

offlineSetupRouter.post('/people', offlineOwner(async (req, res) => {
  const body = personSchema.parse(req.body) as OfflineSetupInput & { setupType: 'person'; name: string; businessId: string; kind: 'receivable' | 'payable' | 'salary'; opening: number; salary: number; role: string; clientRef: string };
  const id = offlineSetupEntityId(body);
  const created = await locked(req.user!.id, body.clientRef, async (client) => {
    await requireParent(client, 'businesses', body.businessId);
    const existing = await client.query<{ name: string; business_id: string; kind: string; opening: number; salary: number; role: string }>('SELECT name, business_id, kind, opening, salary, role FROM people WHERE id = $1', [id]);
    const row = existing.rows[0];
    if (row) {
      if (row.name !== body.name || row.business_id !== body.businessId || row.kind !== body.kind || !sameNumber(row.opening, body.opening) || !sameNumber(row.salary, body.salary) || row.role !== body.role) reused();
      return false;
    }
    await client.query(`INSERT INTO people (id, name, role, business_id, kind, opening, salary) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, body.name, body.role, body.businessId, body.kind, body.opening, body.salary]);
    await auditSetup(client, 'person', id, body);
    return true;
  });
  res.status(created ? 201 : 200).json({ id, ...body, created });
}));

offlineSetupRouter.post('/reminders', offlineOwner(async (req, res) => {
  const body = reminderSchema.parse(req.body) as OfflineSetupInput & { setupType: 'reminder'; what: string; amount: number; accountId: string | null; note: string; clientRef: string };
  const id = offlineSetupEntityId(body);
  const created = await locked(req.user!.id, body.clientRef, async (client) => {
    if (body.accountId) await requireParent(client, 'accounts', body.accountId);
    const existing = await client.query<{ what: string; amount: number; account_id: string | null; note: string; settled: boolean }>('SELECT what, amount, account_id, note, settled FROM reminders WHERE id = $1', [id]);
    const row = existing.rows[0];
    if (row) {
      if (row.what !== body.what || !sameNumber(row.amount, body.amount) || row.account_id !== (body.accountId ?? null) || row.note !== body.note || row.settled) reused();
      return false;
    }
    await client.query('INSERT INTO reminders (id, what, amount, account_id, note) VALUES ($1,$2,$3,$4,$5)', [id, body.what, body.amount, body.accountId ?? null, body.note]);
    await auditSetup(client, 'reminder', id, body);
    return true;
  });
  res.status(created ? 201 : 200).json({ id, ...body, created });
}));

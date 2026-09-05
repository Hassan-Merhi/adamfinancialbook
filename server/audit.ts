/**
 * Who did what, and when.
 *
 * Ordinary operational lines remain best-effort. Accounting mutations use
 * recordRequired with the same PostgreSQL client as the mutation so money and
 * its audit trail either commit together or both roll back.
 */
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { query } from './db.js';
import { currentRequestActor, type RequestActor } from './request-context.js';
import type { AuditLine } from '../shared/types.js';

export async function record(
  req: Request,
  action: string,
  subject?: string | null,
  detail: Record<string, unknown> = {},
  transactionId?: string | null,
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit (actor, actor_email, action, subject, detail, transaction_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        req.user?.id ?? null,
        req.user?.email ?? null,
        action,
        subject ?? null,
        JSON.stringify(detail),
        transactionId ?? null,
      ],
    );
  } catch (err) {
    console.warn('Could not write the audit line:', (err as Error).message);
  }
}

export async function recordRequired(
  client: Pick<PoolClient, 'query'>,
  action: string,
  subject?: string | null,
  detail: Record<string, unknown> = {},
  transactionId?: string | null,
  actorOverride?: RequestActor | null,
): Promise<void> {
  const actor = actorOverride === undefined ? currentRequestActor() : actorOverride;
  await client.query(
    `INSERT INTO audit (actor, actor_email, action, subject, detail, transaction_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      actor?.id ?? null,
      actor?.email ?? null,
      action,
      subject ?? null,
      JSON.stringify(detail),
      transactionId ?? null,
    ],
  );
}

export async function history(limit = 200): Promise<AuditLine[]> {
  const rows = await query<{
    id: string;
    at: Date;
    actor_email: string | null;
    action: string;
    subject: string | null;
    detail: Record<string, unknown>;
    transaction_id: string | null;
  }>(
    `SELECT id, at, actor_email, action, subject, detail, transaction_id
       FROM audit ORDER BY at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    at: new Date(r.at).toISOString(),
    actorEmail: r.actor_email,
    action: r.action,
    subject: r.subject,
    detail: r.detail ?? {},
    transactionId: r.transaction_id,
  }));
}

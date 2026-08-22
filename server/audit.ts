/**
 * Who did what, and when.
 *
 * Written beside the book, never edited, and never in the way: if writing a
 * line fails, the thing the user asked for still stands.
 */
import type { Request } from 'express';
import { query } from './db.js';
import type { AuditLine } from '../shared/types.js';

export async function record(
  req: Request, action: string, subject?: string | null, detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    await query(
      'INSERT INTO audit (actor, actor_email, action, subject, detail) VALUES ($1,$2,$3,$4,$5)',
      [req.user?.id ?? null, req.user?.email ?? null, action, subject ?? null, JSON.stringify(detail)]);
  } catch (err) {
    console.warn('Could not write the audit line:', (err as Error).message);
  }
}

export async function history(limit = 200): Promise<AuditLine[]> {
  const rows = await query<{
    id: string; at: Date; actor_email: string | null; action: string;
    subject: string | null; detail: Record<string, unknown>;
  }>('SELECT id, at, actor_email, action, subject, detail FROM audit ORDER BY at DESC, id DESC LIMIT $1', [limit]);
  return rows.map((r) => ({
    id: String(r.id),
    at: new Date(r.at).toISOString(),
    actorEmail: r.actor_email,
    action: r.action,
    subject: r.subject,
    detail: r.detail ?? {},
  }));
}

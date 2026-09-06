import type { Request } from 'express';
import { query } from './db.js';
import type { LiveMutationImpact } from '../shared/live-updates.js';

export interface LiveAudience {
  all: boolean;
  owners: boolean;
  userIds: string[];
}

export interface LiveClientIdentity {
  userId: string;
  role: 'owner' | 'entry';
}

const ownersOnly = (): LiveAudience => ({ all: false, owners: true, userIds: [] });
const everyone = (): LiveAudience => ({ all: true, owners: true, userIds: [] });

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

export function audienceAllows(audience: LiveAudience, client: LiveClientIdentity): boolean {
  return audience.all || (audience.owners && client.role === 'owner') || audience.userIds.includes(client.userId);
}

async function usersForAccounts(accountIds: string[]): Promise<string[]> {
  const ids = unique(accountIds);
  if (!ids.length) return [];
  const rows = await query<{ user_id: string }>(
    'SELECT DISTINCT user_id FROM user_accounts WHERE account_id = ANY($1::text[])',
    [ids],
  );
  return rows.map((row) => row.user_id);
}

function bodyObject(req: Request): Record<string, unknown> {
  const body = req.body;
  return body && typeof body === 'object' && !Buffer.isBuffer(body) && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function text(body: Record<string, unknown>, key: string): string | null {
  return typeof body[key] === 'string' ? body[key] as string : null;
}

function textArray(body: Record<string, unknown>, key: string): string[] {
  return Array.isArray(body[key]) ? (body[key] as unknown[]).filter((item): item is string => typeof item === 'string') : [];
}

async function entryAccounts(entryId: string): Promise<string[]> {
  const rows = await query<{ account_id: string | null; to_account_id: string | null }>(
    'SELECT account_id, to_account_id FROM entries WHERE id = $1',
    [entryId],
  );
  const row = rows[0];
  return row ? unique([row.account_id, row.to_account_id]) : [];
}

async function transferAudience(transferId: string): Promise<LiveAudience> {
  const rows = await query<{
    recipient_user_id: string;
    from_account_id: string;
    to_account_id: string;
  }>(
    `SELECT recipient_user_id, from_account_id, to_account_id
       FROM pending_transfers WHERE id = $1`,
    [transferId],
  );
  const row = rows[0];
  if (!row) return ownersOnly();
  const assigned = await usersForAccounts([row.from_account_id, row.to_account_id]);
  return { all: false, owners: true, userIds: unique([row.recipient_user_id, ...assigned]) };
}

async function approvalAudience(approvalId: string): Promise<LiveAudience> {
  const rows = await query<{ created_by: string; account_id: string | null }>(
    'SELECT created_by, account_id FROM approval_requests WHERE id = $1',
    [approvalId],
  );
  const row = rows[0];
  if (!row) return ownersOnly();
  const assigned = row.account_id ? await usersForAccounts([row.account_id]) : [];
  return { all: false, owners: true, userIds: unique([row.created_by, ...assigned]) };
}

/**
 * Decide which authenticated users need one mutation signal. Financial values
 * never leave their normal authorized GET endpoints; this only narrows who is
 * asked to revalidate.
 */
export async function resolveLiveAudience(
  req: Request,
  path: string,
  _impact: LiveMutationImpact,
): Promise<LiveAudience> {
  const actorId = req.user?.id ?? null;
  const actorRole = req.user?.role ?? null;
  const body = bodyObject(req);

  // A full book reset changes every delegated wallet as well as the owner view.
  if (path === '/api/reset-book') return everyone();

  // Changing assigned accounts must immediately reshape that delegate's own
  // overview, even though the change itself was made by an owner.
  const assignmentMatch = /^\/api\/delegation\/users\/([^/]+)\/accounts$/.exec(path);
  if (assignmentMatch) {
    return { all: false, owners: true, userIds: unique([assignmentMatch[1]]) };
  }

  // User administration is private to owners plus the user whose access/state
  // changed. Collection-level writes have no pre-existing target id.
  const userMatch = /^\/api\/users\/([^/]+)/.exec(path);
  if (userMatch) return { all: false, owners: true, userIds: unique([userMatch[1]]) };
  if (/^\/api\/users(?:\/|$)/.test(path)) return ownersOnly();

  // Owner-only catalog/setup changes do not change another delegate's current
  // assigned-wallet snapshot unless an assignment route above says so.
  if (/^\/api\/(?:businesses|accounts|projects|people|loans|reminders)(?:\/|$)/.test(path)) {
    return ownersOnly();
  }

  if (path === '/api/entries') {
    const accountIds = unique([text(body, 'accountId'), text(body, 'toAccountId')]);
    const assigned = await usersForAccounts(accountIds);
    return {
      all: false,
      owners: true,
      userIds: unique([actorRole === 'entry' ? actorId : null, ...assigned]),
    };
  }

  const entryMatch = /^\/api\/entries\/([^/]+)(?:\/void)?$/.exec(path);
  if (entryMatch) {
    const assigned = await usersForAccounts(await entryAccounts(entryMatch[1]));
    return { all: false, owners: true, userIds: unique([actorRole === 'entry' ? actorId : null, ...assigned]) };
  }

  if (path === '/api/delegation/transfers') {
    const accountIds = unique([text(body, 'fromAccountId'), text(body, 'toAccountId')]);
    const assigned = await usersForAccounts(accountIds);
    return { all: false, owners: true, userIds: unique([...assigned]) };
  }

  const transferMatch = /^\/api\/delegation\/transfers\/([^/]+)\/(?:confirm|reject)$/.exec(path);
  if (transferMatch) return transferAudience(transferMatch[1]);

  if (path === '/api/delegation/approvals') {
    return { all: false, owners: true, userIds: unique([actorId]) };
  }

  const approvalMatch = /^\/api\/delegation\/approvals\/([^/]+)\/decision$/.exec(path);
  if (approvalMatch) return approvalAudience(approvalMatch[1]);

  // Generic delegation writes are usually relevant only to owners plus the
  // actor/explicit delegate. Account ids in the body extend that audience to
  // whoever is assigned to those accounts.
  if (path.startsWith('/api/delegation/')) {
    const accountIds = unique([
      text(body, 'accountId'), text(body, 'fromAccountId'), text(body, 'toAccountId'),
      ...textArray(body, 'accountIds'),
    ]);
    const assigned = await usersForAccounts(accountIds);
    return {
      all: false,
      owners: true,
      userIds: unique([actorRole === 'entry' ? actorId : null, text(body, 'userId'), ...assigned]),
    };
  }

  // Conservative fallback: owner writes stay owner-only; delegated writes keep
  // the actor in sync. If future routes are added, tests should give them a
  // more precise audience rather than widening every connected device.
  return {
    all: false,
    owners: true,
    userIds: unique([actorRole === 'entry' ? actorId : null]),
  };
}

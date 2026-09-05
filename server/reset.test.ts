import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query: clientQuery, release }));
  const poolQuery = vi.fn();
  return { clientQuery, release, connect, poolQuery };
});

vi.mock('./db.js', () => ({
  pool: { connect: mocks.connect, query: mocks.poolQuery },
}));

vi.mock('./auth.js', () => ({
  ownerOnly: (_req: unknown, _res: unknown, next: () => void) => next(),
  verifyPassword: vi.fn(async () => true),
}));

import { performReset } from './reset.js';

const COUNTS = {
  businesses: 2,
  accounts: 4,
  projects: 3,
  people: 5,
  entries: 9,
  reminders: 1,
  approvals: 2,
  pending_transfers: 1,
  attachments: 4,
  delegated_accounts: 2,
  notifications: 6,
  audit_lines: 12,
  other_users: 3,
};

function sqlCalls(): string[] {
  return mocks.clientQuery.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());
}

describe('performReset', () => {
  beforeEach(() => {
    mocks.clientQuery.mockReset();
    mocks.release.mockReset();
    mocks.connect.mockClear();
    mocks.clientQuery.mockImplementation(async (sql: string) => ({
      rows: String(sql).trimStart().startsWith('SELECT') ? [COUNTS] : [],
    }));
  });

  it('clears activity while preserving setup, assignments, users, and opening receipts', async () => {
    const before = await performReset('activity', 'usr_owner');
    const calls = sqlCalls();

    expect(before.entries).toBe(9);
    expect(calls.some((sql) => sql.startsWith('CREATE TEMP TABLE reset_activity_receipts'))).toBe(true);
    expect(calls).toContain('DELETE FROM entry_revisions');
    expect(calls).toContain('DELETE FROM effects');
    expect(calls).toContain('UPDATE entries SET link_receipt_id = NULL WHERE link_receipt_id IS NOT NULL');
    expect(calls).toContain('DELETE FROM entries');
    expect(calls).toContain('DELETE FROM project_receipts WHERE id IN (SELECT id FROM reset_activity_receipts)');
    expect(calls).not.toContain('DELETE FROM user_accounts');
    expect(calls).not.toContain('DELETE FROM accounts');
    expect(calls.some((sql) => sql.startsWith('DELETE FROM users'))).toBe(false);
    expect(calls.at(-1)).toBe('COMMIT');
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('starts a fresh book while keeping every login user', async () => {
    await performReset('book', 'usr_owner');
    const calls = sqlCalls();

    expect(calls).toContain('DELETE FROM user_accounts');
    expect(calls).toContain('DELETE FROM accounts');
    expect(calls).toContain('DELETE FROM businesses');
    expect(calls.some((sql) => sql.startsWith('DELETE FROM users'))).toBe(false);
  });

  it('factory reset deletes other users but never the acting owner', async () => {
    await performReset('everything', 'usr_owner');
    const calls = sqlCalls();

    expect(calls).toContain('DELETE FROM users WHERE id <> $1');
    const userDelete = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM users'));
    expect(userDelete?.[1]).toEqual(['usr_owner']);
  });

  it('rolls back and releases the connection when deletion fails', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).trimStart().startsWith('SELECT')) return { rows: [COUNTS] };
      if (String(sql) === 'DELETE FROM entries') throw new Error('database refused delete');
      return { rows: [] };
    });

    await expect(performReset('activity', 'usr_owner')).rejects.toThrow('database refused delete');
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});

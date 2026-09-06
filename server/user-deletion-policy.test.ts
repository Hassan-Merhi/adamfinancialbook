import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, 'migrations', '007_user_deletion.sql'), 'utf8');

describe('permanent user deletion migration', () => {
  it('removes the old physical-delete blocker', () => {
    expect(sql).toContain('DROP TRIGGER IF EXISTS users_no_delete ON users');
    expect(sql).toContain('DROP FUNCTION IF EXISTS prevent_physical_user_delete()');
  });

  it('preserves historical transfer, approval and attachment rows', () => {
    expect(sql).toMatch(/pending_transfers[\s\S]*requested_by DROP NOT NULL[\s\S]*ON DELETE SET NULL/);
    expect(sql).toMatch(/approval_requests[\s\S]*created_by DROP NOT NULL[\s\S]*ON DELETE SET NULL/);
    expect(sql).toMatch(/attachments[\s\S]*uploaded_by DROP NOT NULL[\s\S]*ON DELETE SET NULL/);
  });

  it('cascades disposable login sessions with the deleted user', () => {
    expect(sql).toMatch(/user_sessions[\s\S]*user_id[\s\S]*ON DELETE CASCADE/);
  });
});

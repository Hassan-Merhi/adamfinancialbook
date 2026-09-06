import fs from 'node:fs';

function replaceOnce(source, needle, replacement, label) {
  if (source.includes(replacement)) return source;
  if (!source.includes(needle)) throw new Error(`Phase 5 insertion point not found: ${label}`);
  return source.replace(needle, replacement);
}

const attachmentsPath = 'client/src/offline-attachments.ts';
let attachments = fs.readFileSync(attachmentsPath, 'utf8');

attachments = replaceOnce(
  attachments,
  `async function recordsForUser(userId: string): Promise<OfflineAttachmentRecord[]> {\n`,
  `async function removeRecords(records: readonly OfflineAttachmentRecord[]): Promise<void> {\n  if (!records.length) return;\n  const db = await openDb();\n  if (!db) {\n    for (const record of records) memory.delete(storageKey(record.userId, record.id));\n    emitChange();\n    return;\n  }\n  const transaction = db.transaction(ATTACHMENTS, 'readwrite');\n  const store = transaction.objectStore(ATTACHMENTS);\n  for (const record of records) store.delete(storageKey(record.userId, record.id));\n  await transactionDone(transaction);\n  emitChange();\n}\n\nfunction matchesTarget(record: OfflineAttachmentRecord, target: AttachmentTarget): boolean {\n  if (typeof target.entryId === 'string') return record.entryId === target.entryId;\n  return record.entryClientRef === target.clientRef;\n}\n\nasync function recordsForUser(userId: string): Promise<OfflineAttachmentRecord[]> {\n`,
  'attachment removal helpers',
);

attachments = replaceOnce(
  attachments,
  `async function attempt(record: OfflineAttachmentRecord, force: boolean): Promise<boolean> {\n  if (record.status === 'uploaded') return false;\n`,
  `async function attempt(record: OfflineAttachmentRecord, force: boolean, expectedUserId = record.userId): Promise<boolean> {\n  if (record.userId !== expectedUserId || activeUserId() !== expectedUserId) return false;\n  if (record.status === 'uploaded') return false;\n`,
  'attempt user guard',
);

attachments = replaceOnce(
  attachments,
  `    if (!entryId) {\n      const nextAttemptAt = new Date(Date.now() + retryDelayMs(working.attempts)).toISOString();\n`,
  `    if (!entryId) {\n      const nextAttemptAt = new Date(Date.now() + retryDelayMs(working.attempts)).toISOString();\n`,
  'resolve unchanged anchor',
);

attachments = replaceOnce(
  attachments,
  `    if (working.entryId !== entryId) {\n      working.entryId = entryId;\n      await put(working);\n    }\n\n    const response = await upload(working, entryId);\n`,
  `    if (activeUserId() !== expectedUserId) {\n      await put({\n        ...working,\n        status: 'waiting',\n        nextAttemptAt: null,\n        lastError: 'Receipt sync paused because the signed-in user changed.',\n      });\n      return false;\n    }\n\n    if (working.entryId !== entryId) {\n      working.entryId = entryId;\n      await put(working);\n    }\n\n    const response = await upload(working, entryId);\n`,
  'pre-upload user recheck',
);

attachments = replaceOnce(
  attachments,
  `  const checked = validateAttachmentFiles(files);\n  const queuedAt = new Date().toISOString();\n`,
  `  const checked = validateAttachmentFiles(files);\n  const existingForTarget = (await recordsForUser(userId)).filter((record) => matchesTarget(record, target));\n  if (existingForTarget.length + checked.length > MAX_OFFLINE_ATTACHMENTS_PER_ENTRY) {\n    throw new Error(\`Attach at most \${MAX_OFFLINE_ATTACHMENTS_PER_ENTRY} receipts to one transaction.\`);\n  }\n  const queuedAt = new Date().toISOString();\n`,
  'target-wide receipt limit',
);

attachments = replaceOnce(
  attachments,
  `    for (const record of records) {\n      const recovered = record.status === 'uploading'\n`,
  `    for (const record of records) {\n      if (activeUserId() !== userId) break;\n      const recovered = record.status === 'uploading'\n`,
  'flush session switch guard',
);

attachments = replaceOnce(
  attachments,
  `      if (await attempt(recovered, options.force === true)) uploaded += 1;\n`,
  `      if (await attempt(recovered, options.force === true, userId)) uploaded += 1;\n`,
  'attempt expected user',
);

attachments = replaceOnce(
  attachments,
  `export async function attachmentSummary(): Promise<OfflineAttachmentSummary> {\n`,
  `export async function discardEntryAttachmentsByClientRef(clientRef: string): Promise<number> {\n  const userId = activeUserId();\n  const normalized = clientRef.trim();\n  if (!userId || !normalized) return 0;\n  const records = (await recordsForUser(userId)).filter((record) => (\n    record.entryClientRef === normalized && record.status !== 'uploaded'\n  ));\n  await removeRecords(records);\n  return records.length;\n}\n\nexport async function attachmentSummary(): Promise<OfflineAttachmentSummary> {\n`,
  'discard by client ref',
);

attachments = replaceOnce(
  attachments,
  `  retryFailed: retryFailedAttachments,\n  summary: attachmentSummary,\n`,
  `  retryFailed: retryFailedAttachments,\n  discardForClientRef: discardEntryAttachmentsByClientRef,\n  summary: attachmentSummary,\n`,
  'attachment queue discard export',
);

fs.writeFileSync(attachmentsPath, attachments);

const statusPath = 'client/src/OfflineAttachmentStatus.tsx';
let status = fs.readFileSync(statusPath, 'utf8');
status = replaceOnce(
  status,
  `  const discardEntry = async (id: string) => {\n    if (!window.confirm('Discard this unsynced entry? It has not been posted to the server.')) return;\n    setBusy(id);\n    try {\n      await outbox.drop(id);\n      emitSyncResult(0, null);\n      await refresh();\n      setMessage('Unsynced entry discarded. No server ledger entry was created.');\n`,
  `  const discardEntry = async (id: string) => {\n    if (!window.confirm('Discard this unsynced entry? It has not been posted to the server.')) return;\n    setBusy(id);\n    try {\n      const item = outbox.records().find((record) => record.id === id);\n      const clientRef = item?.input.clientRef ?? item?.id ?? id;\n      await outbox.drop(id);\n      const discardedReceipts = await attachmentQueue.discardForClientRef(clientRef);\n      emitSyncResult(0, null);\n      await refresh();\n      setMessage(\`Unsynced entry discarded. No server ledger entry was created.\${discardedReceipts ? \` \${discardedReceipts} local \${discardedReceipts === 1 ? 'receipt was' : 'receipts were'} removed too.\` : ''}\`);\n`,
  'discard orphan receipts with entry',
);
fs.writeFileSync(statusPath, status);

const serverPath = 'server/offline-attachments.ts';
let server = fs.readFileSync(serverPath, 'utf8');
server = replaceOnce(
  server,
  `const rawAttachment = express.raw({ type: () => true, limit: '6mb' });\n`,
  `const rawAttachment = express.raw({ type: () => true, limit: '6mb' });\nconst MAX_OFFLINE_ATTACHMENTS_PER_ENTRY = 20;\n`,
  'server receipt limit constant',
);
server = replaceOnce(
  server,
  `    const extension = mime === 'image/jpeg' ? 'jpg'\n`,
  `    const countRows = await query<{ count: number | string }>(\n      'SELECT count(*) AS count FROM attachments WHERE entry_id = $1',\n      [entryId],\n    );\n    if (Number(countRows[0]?.count ?? 0) >= MAX_OFFLINE_ATTACHMENTS_PER_ENTRY) {\n      return res.status(409).json({\n        error: \`Attach at most \${MAX_OFFLINE_ATTACHMENTS_PER_ENTRY} receipts to one transaction.\`,\n        code: 'OFFLINE_ATTACHMENT_LIMIT_REACHED',\n      });\n    }\n\n    const extension = mime === 'image/jpeg' ? 'jpg'\n`,
  'server authoritative target limit',
);
fs.writeFileSync(serverPath, server);

const clientTestPath = 'client/src/offline-phase5-hardening.test.ts';
fs.writeFileSync(clientTestPath, `import { beforeEach, describe, expect, it, vi } from 'vitest';\nimport { initializeOfflineStorage, lastUser, resetOfflineStorageForTests } from './offline';\nimport { attachmentQueue, resetOfflineAttachmentsForTests } from './offline-attachments';\n\nfunction receipt(name: string): File {\n  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], name, { type: 'image/png' });\n}\n\nfunction json(status: number, body: unknown): Response {\n  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });\n}\n\nbeforeEach(async () => {\n  vi.restoreAllMocks();\n  await resetOfflineAttachmentsForTests();\n  await resetOfflineStorageForTests();\n  await initializeOfflineStorage();\n  await lastUser.save({ id: 'phase5_owner', email: 'owner@example.com', role: 'owner' });\n});\n\ndescribe('Offline Phase 5 attachment hardening', () => {\n  it('removes orphaned local receipts when an unsynced entry is discarded', async () => {\n    await attachmentQueue.queue([receipt('one.png'), receipt('two.png')], { clientRef: 'q_drop_me' });\n    await attachmentQueue.queue([receipt('keep.png')], { clientRef: 'q_keep_me' });\n\n    expect((await attachmentQueue.records())).toHaveLength(3);\n    expect(await attachmentQueue.discardForClientRef('q_drop_me')).toBe(2);\n\n    const remaining = await attachmentQueue.records();\n    expect(remaining).toHaveLength(1);\n    expect(remaining[0].entryClientRef).toBe('q_keep_me');\n  });\n\n  it('stops before upload if the signed-in user changes during entry resolution', async () => {\n    let switched = false;\n    let uploadCalls = 0;\n    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {\n      const url = String(input);\n      if (url.includes('/offline/entries/by-client-ref/')) {\n        if (!switched) {\n          switched = true;\n          await lastUser.save({ id: 'different_user', email: 'other@example.com', role: 'entry' });\n        }\n        return json(200, { id: 'ent_phase5_switch' });\n      }\n      if (url.includes('/delegation/attachments/entry/')) {\n        uploadCalls += 1;\n        return json(201, { ok: true });\n      }\n      throw new Error(\`Unexpected request \${url}\`);\n    }));\n\n    await attachmentQueue.queue([receipt('switch.png')], { clientRef: 'q_switch_user' });\n    expect(await attachmentQueue.flush({ force: true })).toBe(0);\n    expect(uploadCalls).toBe(0);\n\n    await lastUser.save({ id: 'phase5_owner', email: 'owner@example.com', role: 'owner' });\n    const waiting = await attachmentQueue.records();\n    expect(waiting[0].status).toBe('waiting');\n    expect(waiting[0].lastError).toMatch(/signed-in user changed/i);\n\n    expect(await attachmentQueue.flush({ force: true })).toBe(1);\n    expect(uploadCalls).toBe(1);\n  });\n\n  it('enforces the 20-receipt limit across multiple queue operations for the same entry', async () => {\n    await attachmentQueue.queue(Array.from({ length: 12 }, (_, index) => receipt(\`a-\${index}.png\`)), { clientRef: 'q_target_limit' });\n    await attachmentQueue.queue(Array.from({ length: 8 }, (_, index) => receipt(\`b-\${index}.png\`)), { clientRef: 'q_target_limit' });\n    expect((await attachmentQueue.records())).toHaveLength(20);\n\n    await expect(attachmentQueue.queue([receipt('too-many.png')], { clientRef: 'q_target_limit' }))\n      .rejects.toThrow(/at most 20/);\n  });\n});\n`);

const integrationPath = 'server/offline-attachments.integration.test.ts';
let integration = fs.readFileSync(integrationPath, 'utf8');
integration = replaceOnce(
  integration,
  `  let entryId = '';\n`,
  `  let entryId = '';\n  let accountId = '';\n`,
  'integration account id',
);
integration = replaceOnce(
  integration,
  `    const account = (await request('/api/accounts', {\n      method: 'POST', session: owner, body: { name: 'Receipt Cash', businessId: business, opening: 1000 },\n    })).data.id;\n`,
  `    const account = (await request('/api/accounts', {\n      method: 'POST', session: owner, body: { name: 'Receipt Cash', businessId: business, opening: 1000 },\n    })).data.id;\n    accountId = account;\n`,
  'remember integration account',
);
integration = replaceOnce(
  integration,
  `  it('keeps unsupported evidence out of PostgreSQL', async () => {\n`,
  `  it('enforces the 20-receipt cap on the server, not only in the browser', async () => {\n    const entry = await request('/api/entries', {\n      method: 'POST', session: owner,\n      body: {\n        occurredOn: '2026-09-06',\n        kind: 'expense',\n        amount: 5,\n        purpose: 'Receipt cap test',\n        raw: 'Receipt cap test',\n        accountId,\n        clientRef: 'q_phase5_receipt_cap',\n      },\n    });\n    expect(entry.response.status).toBe(201);\n\n    for (let index = 0; index < 20; index += 1) {\n      const accepted = await upload(entry.data.id, \`att_sync_cap_\${index}\`, owner, png((index % 200) + 1));\n      expect(accepted.response.status).toBe(201);\n    }\n\n    const blocked = await upload(entry.data.id, 'att_sync_cap_21', owner, png(222));\n    expect(blocked.response.status).toBe(409);\n    expect(blocked.data.code).toBe('OFFLINE_ATTACHMENT_LIMIT_REACHED');\n    expect(Number((await db<{ n: string }>(\n      'SELECT count(*) AS n FROM attachments WHERE entry_id = $1', [entry.data.id],\n    ))[0].n)).toBe(20);\n  });\n\n  it('keeps unsupported evidence out of PostgreSQL', async () => {\n`,
  'server cap integration test',
);
fs.writeFileSync(integrationPath, integration);

fs.writeFileSync('docs/OFFLINE_PHASE5_ATTACHMENT_HARDENING.md', `# Offline Phase 5 — Attachment & Receipt Hardening\n\nPhase 5 makes offline evidence lifecycle-safe around the newer financial outbox.\n\n- Receipts remain user-scoped and are re-checked against the active signed-in user immediately before upload.\n- A sign-out/sign-in switch pauses the old user's receipt queue instead of allowing it to continue under the new session.\n- Discarding an unsynced financial entry also removes its unsynced local receipt blobs, preventing permanent orphan evidence.\n- The 20-receipt limit is enforced across repeated local queue operations and again on the server before insert.\n- Stable attachment IDs retain exactly-once replay semantics after uncertain network failures.\n- Uploaded evidence remains server-authoritative and audited; client cleanup never deletes server evidence.\n- No accounting-rule or database-schema migration is required.\n`);

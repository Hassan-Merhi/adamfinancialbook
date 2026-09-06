import express, { Router, type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { newId, query } from './db.js';
import { record } from './audit.js';

const router = Router();
const wrap = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const uploadRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const rawAttachment = express.raw({ type: () => true, limit: '6mb' });

type AttachmentMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

type AttachmentRow = {
  id: string;
  uploaded_by: string;
  entry_id: string | null;
  approval_request_id: string | null;
  filename: string;
  mime_type: string;
  byte_size: number;
  data: Buffer;
};

function canonicalId(raw: unknown, max = 120): string | null {
  if (typeof raw !== 'string' || raw.length > max) return null;
  const match = /^[A-Za-z0-9_-]+$/.exec(raw);
  return match?.[0] ?? null;
}

function sniffAttachmentMime(data: Buffer): AttachmentMime | null {
  if (data.length >= 5 && data.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (
    data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) return 'image/png';
  if (
    data.length >= 12
    && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  return null;
}

async function canSeeEntry(req: Request, entryId: string): Promise<boolean> {
  if (req.user?.role === 'owner') return true;
  if (!req.user?.id) return false;
  const rows = await query<{ ok: boolean }>(
    `SELECT EXISTS(
       SELECT 1
         FROM entries e
         JOIN user_accounts ua ON ua.user_id = $2
          AND (ua.account_id = e.account_id OR ua.account_id = e.to_account_id)
        WHERE e.id = $1
     ) AS ok`,
    [entryId, req.user.id],
  );
  return !!rows[0]?.ok;
}

async function notifyOwners(req: Request, entryId: string, filename: string): Promise<void> {
  if (req.user?.role !== 'entry') return;
  const owners = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'owner' AND active = true`);
  await Promise.all(owners.map((owner) => query(
    `INSERT INTO notifications (id, user_id, type, title, body, related_type, related_id)
     VALUES ($1,$2,'evidence_added',$3,$4,'entry',$5)`,
    [
      newId('ntf'),
      owner.id,
      `${req.user!.email} added evidence`,
      `${filename} was attached to an expense.`,
      entryId,
    ],
  )));
}

/** Resolve a queued financial clientRef after the entry itself has synced. */
router.get('/offline/entries/by-client-ref/:clientRef', wrap(async (req, res) => {
  const clientRef = canonicalId(req.params.clientRef, 80);
  if (!clientRef) return res.status(400).json({ error: 'Invalid offline entry reference.' });

  const rows = await query<{ id: string }>(
    'SELECT id FROM entries WHERE client_ref = $1 LIMIT 1',
    [clientRef],
  );
  const entry = rows[0];
  if (!entry) return res.status(404).json({ error: 'That offline entry has not reached the server yet.' });
  if (!(await canSeeEntry(req, entry.id))) return res.status(403).json({ error: 'You cannot attach to that expense.' });
  return res.json({ id: entry.id });
}));

/**
 * Phase 5 idempotent receipt upload. Requests without the Phase 5 attachment id
 * fall through to the established evidence route unchanged.
 */
router.post(
  '/delegation/attachments/entry/:entryId',
  uploadRateLimit,
  rawAttachment,
  wrap(async (req, res, next) => {
    const rawAttachmentId = req.get('x-offline-attachment-id');
    if (!rawAttachmentId) return next();

    const attachmentId = canonicalId(rawAttachmentId);
    const entryId = canonicalId(req.params.entryId);
    if (!attachmentId || !entryId) return res.status(400).json({ error: 'Invalid offline attachment reference.' });
    if (!(await canSeeEntry(req, entryId))) return res.status(403).json({ error: 'You cannot attach to that expense.' });

    const rawBody: unknown = req.body;
    if (typeof rawBody === 'string' || Array.isArray(rawBody) || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      return res.status(400).json({ error: 'Choose a receipt or photo first.' });
    }
    const data = Buffer.from(rawBody);
    const byteSize = data.byteLength;
    const mime = sniffAttachmentMime(data);
    if (!mime) return res.status(415).json({ error: 'Use a JPG, PNG, WebP or PDF.' });

    const existing = (await query<AttachmentRow>(
      `SELECT id, uploaded_by, entry_id, approval_request_id, filename, mime_type, byte_size, data
         FROM attachments WHERE id = $1`,
      [attachmentId],
    ))[0];
    if (existing) {
      const exactReplay = existing.uploaded_by === req.user!.id
        && existing.entry_id === entryId
        && existing.approval_request_id === null
        && existing.mime_type === mime
        && Number(existing.byte_size) === byteSize
        && Buffer.from(existing.data).equals(data);
      if (!exactReplay) {
        return res.status(409).json({
          error: 'That offline attachment id is already used by different evidence.',
          code: 'OFFLINE_ATTACHMENT_ID_REUSED',
        });
      }
      return res.status(200).json({
        id: existing.id,
        filename: existing.filename,
        mimeType: existing.mime_type,
        byteSize: Number(existing.byte_size),
        deduplicated: true,
      });
    }

    const extension = mime === 'image/jpeg' ? 'jpg'
      : mime === 'image/png' ? 'png'
      : mime === 'image/webp' ? 'webp'
      : 'pdf';
    const filename = `evidence-${attachmentId}.${extension}`;

    await query(
      `INSERT INTO attachments
        (id, uploaded_by, entry_id, approval_request_id, filename, mime_type, byte_size, data)
       VALUES ($1,$2,$3,NULL,$4,$5,$6,$7)`,
      [attachmentId, req.user!.id, entryId, filename, mime, byteSize, data],
    );
    await notifyOwners(req, entryId, filename);
    await record(req, 'evidence attached', attachmentId, {
      filename,
      bytes: byteSize,
      entryId,
      requestId: null,
      source: 'offline-phase5',
    });
    return res.status(201).json({ id: attachmentId, filename, mimeType: mime, byteSize, deduplicated: false });
  }),
);

export const offlineAttachmentRouter = router;

import 'dotenv/config';
import nodemailer from 'nodemailer';
import { createEncryptedDatabaseBackup } from './backup-service.js';
import { pool } from './db.js';
import { fireOperationalAlert, logOperationalEvent } from './alerts.js';

const smtp = process.env.SMTP_URL;
const to = process.env.BACKUP_TO ?? process.env.REPORT_TO ?? process.env.ALERT_TO;
const from = process.env.BACKUP_FROM ?? process.env.REPORT_FROM ?? process.env.ALERT_FROM ?? to;
const maxBytes = Number(process.env.BACKUP_MAX_EMAIL_BYTES ?? 18 * 1024 * 1024);

if (!smtp || !to || !from) {
  throw new Error('Scheduled backup delivery needs SMTP_URL and BACKUP_TO (or REPORT_TO/ALERT_TO).');
}

try {
  const artifact = await createEncryptedDatabaseBackup('scheduled-email');
  if (artifact.bytes > maxBytes) {
    throw new Error(
      `Encrypted backup is ${artifact.bytes} bytes, above BACKUP_MAX_EMAIL_BYTES=${maxBytes}. `
      + 'Increase the limit only if your mail provider supports it, or move backups to a larger durable destination.',
    );
  }
  const transport = nodemailer.createTransport(smtp);
  await transport.sendMail({
    from,
    to,
    subject: `Adam Financial Book encrypted backup — ${new Date().toISOString().slice(0, 10)}`,
    text: [
      'Encrypted Adam Financial Book PostgreSQL snapshot attached.',
      `Backup id: ${artifact.id}`,
      `SHA-256: ${artifact.checksum}`,
      `Migration: ${artifact.migrationVersion ?? 'unknown'}`,
      `Tables: ${artifact.tableCount}`,
      `Rows: ${artifact.rowCount}`,
      '',
      'Keep BACKUP_ENCRYPTION_KEY separately. The attachment cannot be restored without it.',
    ].join('\n'),
    attachments: [{
      filename: artifact.filename,
      content: artifact.buffer,
      contentType: 'application/octet-stream',
    }],
  });
  logOperationalEvent('backup.email.delivered', {
    id: artifact.id,
    bytes: artifact.bytes,
    checksum: artifact.checksum,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fireOperationalAlert('backup.delivery.failed', { error: message }, 'critical', 0);
  throw error;
} finally {
  await pool.end();
}

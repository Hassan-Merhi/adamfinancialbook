import { query } from './db.js';
import { ensureOperationsSchema } from './operations-schema.js';
import { logOperationalEvent } from './alerts.js';

export interface OffsiteDelivery {
  checksum: string;
  bytes: number;
  deliveryRef: string;
  artifactDigest: string;
  retentionUntil: string;
}

export async function markBackupOffsiteDelivered(id: string, delivery: OffsiteDelivery) {
  await ensureOperationsSchema();
  const rows = await query<{ id: string }>(
    `UPDATE backup_runs
        SET status = 'success',
            destination = 'github-actions-artifact',
            delivered_at = now(),
            delivery_ref = $4,
            artifact_digest = $5,
            retention_until = $6::timestamptz,
            error = NULL
      WHERE id = $1
        AND status = 'success'
        AND destination = 'github-actions-export'
        AND checksum = $2
        AND bytes = $3
      RETURNING id`,
    [id, delivery.checksum, delivery.bytes, delivery.deliveryRef, delivery.artifactDigest, delivery.retentionUntil],
  );
  if (!rows.length) {
    throw new Error('Backup delivery acknowledgement did not match a completed encrypted export.');
  }
  logOperationalEvent('backup.offsite.delivered', {
    id,
    bytes: delivery.bytes,
    checksum: delivery.checksum,
    retentionUntil: delivery.retentionUntil,
  });
}

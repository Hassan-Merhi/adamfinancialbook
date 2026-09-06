import { useEffect, useState } from 'react';
import {
  OFFLINE_ATTACHMENT_EVENT,
  attachmentQueue,
  type OfflineAttachmentSummary,
} from './offline-attachments';
import './offline-attachments.css';

const EMPTY: OfflineAttachmentSummary = { waiting: 0, uploading: 0, uploaded: 0, failed: 0, total: 0 };

export default function OfflineAttachmentStatus() {
  const [summary, setSummary] = useState<OfflineAttachmentSummary>(EMPTY);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void attachmentQueue.summary().then((next) => { if (alive) setSummary(next); });
    };
    refresh();
    window.addEventListener(OFFLINE_ATTACHMENT_EVENT, refresh);
    return () => {
      alive = false;
      window.removeEventListener(OFFLINE_ATTACHMENT_EVENT, refresh);
    };
  }, []);

  const active = summary.waiting + summary.uploading + summary.failed;
  if (!active) return null;

  const retry = async () => {
    setRetrying(true);
    try { await attachmentQueue.retryFailed(); }
    finally {
      setRetrying(false);
      setSummary(await attachmentQueue.summary());
    }
  };

  return (
    <div className={`offline-attachment-status${summary.failed ? ' failed' : ''}`} role={summary.failed ? 'alert' : 'status'}>
      <div>
        <strong>{summary.failed ? 'Receipt needs attention' : 'Receipts are syncing'}</strong>
        <span>
          {summary.uploading ? `${summary.uploading} uploading` : ''}
          {summary.uploading && summary.waiting ? ' · ' : ''}
          {summary.waiting ? `${summary.waiting} waiting` : ''}
          {(summary.uploading || summary.waiting) && summary.failed ? ' · ' : ''}
          {summary.failed ? `${summary.failed} failed after the transaction synced` : ''}
        </span>
      </div>
      {summary.failed > 0 && (
        <button type="button" className="btn ghost" disabled={retrying} onClick={retry}>
          {retrying ? 'Retrying…' : 'Retry receipts'}
        </button>
      )}
    </div>
  );
}

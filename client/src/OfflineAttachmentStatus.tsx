import { useEffect, useMemo, useState } from 'react';
import { api, type LoadedBook } from './api';
import {
  OFFLINE_AUTO_SYNC_EVENT,
  flushOutbox,
  outbox,
  snapshot,
  type OfflineAutoSyncResult,
} from './offline';
import {
  OFFLINE_ATTACHMENT_EVENT,
  attachmentQueue,
  type OfflineAttachmentRecord,
  type OfflineAttachmentSummary,
} from './offline-attachments';
import {
  combinedSyncStatus,
  latestSyncTime,
  readableSyncTime,
} from './offline-sync-ux';
import { money } from './ui';
import './offline-attachments.css';

const EMPTY: OfflineAttachmentSummary = { waiting: 0, uploading: 0, uploaded: 0, failed: 0, total: 0 };

function summarize(records: OfflineAttachmentRecord[]): OfflineAttachmentSummary {
  const result = { ...EMPTY, total: records.length };
  for (const record of records) result[record.status] += 1;
  return result;
}

function entryStatus(status: ReturnType<typeof outbox.status>['status']): string {
  if (status === 'pending') return 'Pending';
  if (status === 'syncing') return 'Syncing';
  if (status === 'retry_wait') return 'Retrying';
  if (status === 'blocked_auth') return 'Sign-in needed';
  if (status === 'conflict') return 'Conflict';
  return 'Rejected';
}

function receiptStatus(status: OfflineAttachmentRecord['status']): string {
  if (status === 'waiting') return 'Waiting';
  if (status === 'uploading') return 'Uploading';
  if (status === 'failed') return 'Failed';
  return 'Uploaded';
}

function emitSyncResult(sent: number, error: string | null): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent<OfflineAutoSyncResult>(OFFLINE_AUTO_SYNC_EVENT, {
    detail: { sent, error },
  }));
}

export default function OfflineAttachmentStatus() {
  const [records, setRecords] = useState<OfflineAttachmentRecord[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [, setEpoch] = useState(0);

  const refresh = async () => {
    setRecords(await attachmentQueue.records().catch(() => []));
    setEpoch((value) => value + 1);
  };

  useEffect(() => {
    let alive = true;
    const update = () => {
      void attachmentQueue.records().then((next) => {
        if (alive) {
          setRecords(next);
          setEpoch((value) => value + 1);
        }
      });
    };
    const connected = () => { setOnline(true); update(); };
    const disconnected = () => { setOnline(false); update(); };
    update();
    window.addEventListener(OFFLINE_ATTACHMENT_EVENT, update);
    window.addEventListener(OFFLINE_AUTO_SYNC_EVENT, update);
    window.addEventListener('online', connected);
    window.addEventListener('offline', disconnected);
    return () => {
      alive = false;
      window.removeEventListener(OFFLINE_ATTACHMENT_EVENT, update);
      window.removeEventListener(OFFLINE_AUTO_SYNC_EVENT, update);
      window.removeEventListener('online', connected);
      window.removeEventListener('offline', disconnected);
    };
  }, []);

  const entryRecords = outbox.records();
  const sync = outbox.summary();
  const receiptSummary = useMemo(() => summarize(records), [records]);
  const status = combinedSyncStatus(online, entryRecords.length, sync, receiptSummary);
  const lastSynced = latestSyncTime(sync, records.map((record) => record.uploadedAt));
  const confirmed = snapshot.loadConfirmed<LoadedBook>();
  const projected = snapshot.load<LoadedBook>();
  const visibleReceipts = records
    .filter((record) => record.status !== 'uploaded')
    .concat(records.filter((record) => record.status === 'uploaded').slice(-5).reverse())
    .slice(0, 25);

  const syncNow = async () => {
    if (!online || busy) return;
    setBusy('sync');
    setMessage('');
    let sent = 0;
    let uploaded = 0;
    let syncError: string | null = null;
    try {
      try {
        sent = await flushOutbox((input) => api.addEntry(input));
      } catch (error) {
        syncError = (error as Error).message;
      }
      try {
        uploaded = await attachmentQueue.flush({ force: true });
      } catch (error) {
        syncError = syncError ?? (error as Error).message;
      }
      await refresh();
      emitSyncResult(sent, syncError);
      if (syncError) setMessage(syncError);
      else if (sent || uploaded) setMessage(`Synced ${sent} ${sent === 1 ? 'entry' : 'entries'} and ${uploaded} ${uploaded === 1 ? 'receipt' : 'receipts'}.`);
      else setMessage('Nothing new to sync.');
    } finally {
      setBusy('');
    }
  };

  const retryEntry = async (id: string) => {
    setBusy(id);
    try {
      await outbox.retry(id);
      await syncNow();
    } finally {
      setBusy('');
      await refresh();
    }
  };

  const rebaseAndSync = async (id: string, patch: { amount?: number; purpose?: string; raw?: string } = {}) => {
    if (!online) return;
    setBusy(id);
    setMessage('');
    try {
      const fresh = await api.overview();
      await snapshot.save(fresh);
      await outbox.rebase(id, fresh, patch);
      await syncNow();
    } catch (error) {
      setMessage((error as Error).message);
      await refresh();
    } finally {
      setBusy('');
    }
  };

  const editAndRetry = async (id: string, amount: number, purpose: string) => {
    const amountText = window.prompt('Amount to post after reviewing the latest server balance:', String(amount));
    if (amountText === null) return;
    const nextAmount = Number(amountText);
    if (!Number.isFinite(nextAmount) || nextAmount <= 0) {
      setMessage('Enter an amount greater than zero.');
      return;
    }
    const nextPurpose = window.prompt('Description / purpose:', purpose) ?? purpose;
    await rebaseAndSync(id, { amount: nextAmount, purpose: nextPurpose, raw: nextPurpose || purpose });
  };

  const discardEntry = async (id: string) => {
    if (!window.confirm('Discard this unsynced entry? It has not been posted to the server.')) return;
    setBusy(id);
    try {
      await outbox.drop(id);
      emitSyncResult(0, null);
      await refresh();
      setMessage('Unsynced entry discarded. No server ledger entry was created.');
    } finally {
      setBusy('');
    }
  };

  const retryReceipts = async () => {
    if (!online) return;
    setBusy('receipts');
    setMessage('');
    try {
      const uploaded = await attachmentQueue.retryFailed();
      await refresh();
      setMessage(uploaded ? `${uploaded} ${uploaded === 1 ? 'receipt' : 'receipts'} uploaded.` : 'Receipt retry finished.');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <section className={`offline-attachment-status sync-center ${status.tone}`} aria-label="Sync Center">
      <div className="sync-center-compact">
        <button type="button" className="sync-center-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          <span className={`sync-dot ${status.tone}`} aria-hidden="true" />
          <span className="sync-center-copy">
            <strong>{status.label}</strong>
            <span>{status.detail} · Last synced {readableSyncTime(lastSynced)}</span>
          </span>
          <span className="sync-chevron" aria-hidden="true">{expanded ? '−' : '+'}</span>
        </button>
        {online && status.outstanding > 0 && (
          <button type="button" className="btn ghost sync-now-compact" disabled={busy === 'sync'} onClick={() => void syncNow()}>
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </div>

      {expanded && (
        <div className="sync-center-panel">
          <div className="sync-center-stats" aria-label="Sync status summary">
            <SyncStat label="Connection" value={online ? 'Online' : 'Offline'} />
            <SyncStat label="Pending entries" value={entryRecords.length} />
            <SyncStat label="Conflicts" value={sync.conflicts} bad={sync.conflicts > 0} />
            <SyncStat label="Rejected" value={sync.rejected} bad={sync.rejected > 0} />
            <SyncStat label="Receipts waiting" value={receiptSummary.waiting + receiptSummary.uploading} />
            <SyncStat label="Receipt failures" value={receiptSummary.failed} bad={receiptSummary.failed > 0} />
          </div>

          {confirmed && projected && (
            <div className="sync-balance-card">
              <div><span>Server confirmed</span><strong className="num">{money(confirmed.balances.totalCash)}</strong></div>
              <div><span>Projected on this device</span><strong className="num">{money(projected.balances.totalCash)}</strong></div>
              <small>Projected cash includes the safe, ordered prefix of unsynced entries. Conflicted or rejected work is never silently counted past the blocking item.</small>
            </div>
          )}

          <div className="sync-center-actions">
            <button type="button" className="btn" disabled={!online || busy === 'sync'} onClick={() => void syncNow()}>
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
            {receiptSummary.failed > 0 && (
              <button type="button" className="btn ghost" disabled={!online || busy === 'receipts'} onClick={() => void retryReceipts()}>
                {busy === 'receipts' ? 'Retrying…' : 'Retry failed receipts'}
              </button>
            )}
          </div>

          {message && <div className={`sync-center-message${status.tone === 'bad' ? ' bad' : ''}`} role={status.tone === 'bad' ? 'alert' : 'status'}>{message}</div>}

          {entryRecords.length > 0 && (
            <div className="sync-center-list">
              <h4>Transactions on this device <span>{entryRecords.length}</span></h4>
              {entryRecords.slice(0, 50).map((item) => {
                const state = outbox.status(item.id);
                const purpose = item.input.purpose || item.input.raw || 'Financial entry';
                const blocked = state.status === 'conflict' || state.status === 'rejected' || state.status === 'blocked_auth';
                return (
                  <div className={`sync-item${blocked ? ' problem' : ''}`} key={item.id}>
                    <div className="sync-item-copy">
                      <b>{purpose}</b>
                      <span>{entryStatus(state.status)} · {new Date(item.queuedAt).toLocaleString()}</span>
                      {state.lastError?.message && <small>{state.lastError.message}</small>}
                    </div>
                    <strong className="num">{money(item.input.amount)}</strong>
                    <div className="sync-item-actions">
                      {state.status === 'retry_wait' && <button className="btn ghost small" disabled={!online || !!busy} onClick={() => void retryEntry(item.id)}>Retry now</button>}
                      {state.status === 'rejected' && <button className="btn ghost small" disabled={!online || !!busy} onClick={() => void retryEntry(item.id)}>Retry</button>}
                      {state.status === 'conflict' && (
                        <>
                          <button className="btn small" disabled={!online || !!busy} onClick={() => void rebaseAndSync(item.id)}>Use latest &amp; retry</button>
                          <button className="btn ghost small" disabled={!online || !!busy} onClick={() => void editAndRetry(item.id, item.input.amount, purpose)}>Edit &amp; retry</button>
                        </>
                      )}
                      {(state.status === 'conflict' || state.status === 'rejected') && (
                        <button className="btn ghost small danger" disabled={!!busy} onClick={() => void discardEntry(item.id)}>Discard</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {visibleReceipts.length > 0 && (
            <div className="sync-center-list">
              <h4>Receipts on this device <span>{receiptSummary.waiting + receiptSummary.uploading + receiptSummary.failed} active</span></h4>
              {visibleReceipts.map((record) => (
                <div className={`sync-item${record.status === 'failed' ? ' problem' : ''}`} key={record.id}>
                  <div className="sync-item-copy">
                    <b>{record.filename}</b>
                    <span>{receiptStatus(record.status)} · {(record.byteSize / 1024).toFixed(record.byteSize < 1024 * 100 ? 1 : 0)} KB</span>
                    {record.lastError && <small>{record.lastError}</small>}
                  </div>
                  <span className={`sync-chip ${record.status}`}>{receiptStatus(record.status)}</span>
                </div>
              ))}
            </div>
          )}

          {entryRecords.length === 0 && receiptSummary.waiting === 0 && receiptSummary.uploading === 0 && receiptSummary.failed === 0 && (
            <div className="sync-center-clear"><b>Everything is synced.</b><span>No financial work is waiting on this device.</span></div>
          )}
        </div>
      )}
    </section>
  );
}

function SyncStat({ label, value, bad }: { label: string; value: string | number; bad?: boolean }) {
  return (
    <div className={`sync-stat${bad ? ' bad' : ''}`}>
      <span>{label}</span>
      <b className="num">{value}</b>
    </div>
  );
}

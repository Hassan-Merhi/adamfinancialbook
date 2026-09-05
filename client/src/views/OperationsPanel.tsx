import { useEffect, useState } from 'react';

type Status = {
  ok: boolean;
  checkedAt: string;
  database: { status: string; latencyMs: number | null; pool: { total: number; idle: number; waiting: number } };
  migrations: { current: number | null; latest: number | null; pending: string[] };
  backup: null | {
    id: string;
    completedAt: string | null;
    status: string;
    destination: string;
    bytes: number | null;
    ageHours: number | null;
    encrypted: boolean;
    error: string | null;
  };
  requests: { total: number; responses5xx: number; p95Ms: number; maxMs: number };
  events24h: { warn: number; error: number; critical: number };
};

function fmtBytes(value: number | null) {
  if (value === null) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export default function OperationsPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setError('');
      const response = await fetch('/api/operations/status', { credentials: 'same-origin' });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? 'Could not load operations status.');
      setStatus(await response.json() as Status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load operations status.');
    }
  };

  useEffect(() => { void refresh(); }, []);

  const downloadBackup = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/operations/backup', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-book': '1' },
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? 'Backup failed.');
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') ?? '';
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `adam-financial-book-${new Date().toISOString().slice(0, 10)}.afb`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card setup-card" id="setup-recovery">
      <div className="dhead">
        <div>
          <h3>Backup & recovery <span className="muted">owner only</span></h3>
          <p className="muted">Encrypted database backups, recovery status, and production health.</p>
        </div>
        <button className="btn secondary" onClick={() => void refresh()}>Refresh</button>
      </div>

      {error && <div className="note danger">{error}</div>}
      {!status ? <div className="muted">Loading operations status…</div> : <>
        <div className="setup-existing">
          <div className="row"><span className="main"><b>Database</b><small>connection + migrations</small></span><span className="val">{status.database.status === 'ok' && status.migrations.pending.length === 0 ? 'Healthy' : 'Needs attention'}<small>{status.database.latencyMs === null ? 'no response' : `${status.database.latencyMs} ms`}</small></span></div>
          <div className="row"><span className="main"><b>Latest encrypted backup</b><small>{status.backup?.destination ?? 'no successful run recorded yet'}</small></span><span className="val">{status.backup?.status ?? 'None'}<small>{status.backup?.completedAt ? `${status.backup.ageHours ?? 0}h ago · ${fmtBytes(status.backup.bytes)}` : ''}</small></span></div>
          <div className="row"><span className="main"><b>API health</b><small>{status.requests.total} observed requests</small></span><span className="val">p95 {status.requests.p95Ms} ms<small>{status.requests.responses5xx} server errors</small></span></div>
          <div className="row"><span className="main"><b>Operational events</b><small>last 24 hours</small></span><span className="val">{status.events24h.critical} critical<small>{status.events24h.error} errors · {status.events24h.warn} warnings</small></span></div>
        </div>
        {status.backup?.status === 'failed' && status.backup.error && <div className="note danger">Last backup failed: {status.backup.error}</div>}
      </>}

      <div className="note">
        Backups are encrypted before they leave the server. Keep <b>BACKUP_ENCRYPTION_KEY</b> somewhere separate from the backup file; recovery is impossible without it.
      </div>
      <button className="btn" disabled={busy} onClick={() => void downloadBackup()}>{busy ? 'Creating encrypted backup…' : 'Download encrypted backup'}</button>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { outbox, snapshot } from '../offline';
import { clearCurrentUserOfflineAttachments } from '../offline-reset-storage';
import { PINNED_ACCOUNTS_KEY } from '../favorites';
import { RESET_CONFIRMATIONS, RESET_LABELS, type ResetScope } from '../../../shared/reset';
import './ResetData.css';

interface ResetPreview {
  businesses: number;
  accounts: number;
  projects: number;
  people: number;
  entries: number;
  reminders: number;
  approvals: number;
  pendingTransfers: number;
  attachments: number;
  delegatedAccounts: number;
  notifications: number;
  auditLines: number;
  otherUsers: number;
}

const OPTIONS: Array<{ scope: ResetScope; title: string; text: string; keep: string }> = [
  {
    scope: 'activity',
    title: 'Clear activity',
    text: 'Remove transactions, approvals, pending handoffs, receipts/files, reminders, notifications and old audit history.',
    keep: 'Keeps businesses, accounts, projects, people, opening balances, delegated account access and all login users.',
  },
  {
    scope: 'book',
    title: 'Start fresh book',
    text: 'Erase all financial activity and all setup data so the book opens empty again.',
    keep: 'Keeps everyone who can sign in, including their passwords and roles. Account assignments are cleared because the accounts are removed.',
  },
  {
    scope: 'everything',
    title: 'Factory reset',
    text: 'Erase the entire financial book and remove every other login user.',
    keep: 'Keeps only your current owner login and the database structure, so you cannot lock yourself out.',
  },
];

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers = new Headers();
  if (method !== 'GET') {
    headers.set('content-type', 'application/json');
    headers.set('x-book', '1');
  }
  const response = await fetch(`/api/reset${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!response.ok) throw new Error(data?.error || `Reset request failed (${response.status})`);
  return data as T;
}

function countText(scope: ResetScope, preview: ResetPreview | null): string {
  if (!preview) return 'Loading the current totals…';
  if (scope === 'activity') {
    return [
      `${preview.entries} entries`,
      `${preview.approvals} approvals`,
      `${preview.pendingTransfers} pending transfers`,
      `${preview.attachments} files`,
      `${preview.reminders} reminders`,
    ].join(' · ');
  }
  const setup = [
    `${preview.businesses} businesses`,
    `${preview.accounts} accounts`,
    `${preview.projects} projects`,
    `${preview.people} people`,
    `${preview.entries} entries`,
  ];
  if (scope === 'everything') setup.push(`${preview.otherUsers} other users`);
  return setup.join(' · ');
}

export default function ResetData() {
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [scope, setScope] = useState<ResetScope | null>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadPreview = async () => {
    try {
      const data = await request<{ counts: ResetPreview }>('/preview');
      setPreview(data.counts);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => { void loadPreview(); }, []);

  const exact = scope ? RESET_CONFIRMATIONS[scope] : '';
  const selected = useMemo(() => OPTIONS.find((option) => option.scope === scope) ?? null, [scope]);
  const canReset = !!scope && !!password && confirmation === exact && !busy;

  const choose = (next: ResetScope) => {
    setScope(next);
    setPassword('');
    setConfirmation('');
    setError('');
  };

  const reset = async () => {
    if (!scope || !canReset) return;
    setBusy(true);
    setError('');
    try {
      await request('/', 'POST', { scope, password, confirmation });

      // A successful server reset must also remove stale offline state. Await
      // every IndexedDB write before reloading so an old transaction or receipt
      // cannot survive the reset and later bind to the new book.
      await outbox.clear();
      await clearCurrentUserOfflineAttachments();
      await snapshot.save(null);
      if (scope !== 'activity') {
        try { localStorage.removeItem(PINNED_ACCOUNTS_KEY); } catch { /* private mode */ }
      }
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      void loadPreview();
    }
  };

  return (
    <div className="card reset-card">
      <h3>
        <span>Reset &amp; start fresh</span>
        <span className="muted">owner only</span>
      </h3>

      <div className="reset-intro">
        <div>
          <b>Choose exactly how much to clear.</b>
          <p>These actions are permanent. Take a backup first if there is anything you may need later.</p>
        </div>
        <div className="reset-backups">
          <a href="/api/backup.json">Download full backup</a>
          <a href="/api/export/entries.csv">Download entries CSV</a>
        </div>
      </div>

      <div className="reset-options">
        {OPTIONS.map((option) => (
          <button
            type="button"
            key={option.scope}
            className={`reset-option ${scope === option.scope ? 'selected' : ''}`}
            aria-pressed={scope === option.scope}
            onClick={() => choose(option.scope)}
          >
            <span className="reset-option-title">{option.title}</span>
            <span>{option.text}</span>
            <small>{option.keep}</small>
          </button>
        ))}
      </div>

      {selected && scope && (
        <div className="reset-confirm" role="region" aria-label={`${selected.title} confirmation`}>
          <div className="reset-warning">
            <b>{RESET_LABELS[scope]}</b>
            <span>{countText(scope, preview)}</span>
          </div>

          <div className="reset-fields">
            <div className="f">
              <label>Current owner password</label>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Required"
              />
            </div>
            <div className="f">
              <label>Type {exact}</label>
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={exact}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          </div>

          {error && <div className="note err reset-error" role="alert">{error}</div>}

          <div className="reset-actions">
            <button type="button" className="btn ghost" onClick={() => setScope(null)} disabled={busy}>Cancel</button>
            <button type="button" className="btn reset-danger" onClick={() => void reset()} disabled={!canReset}>
              {busy ? 'Clearing…' : RESET_LABELS[scope]}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

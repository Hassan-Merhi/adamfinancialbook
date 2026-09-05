import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { api, type EvidenceActivity, type EvidenceDashboard, type LoadedBook } from '../api';
import { receiptsNotInCash } from '../../../shared/engine';
import { Card, Empty, money, shortDate } from '../ui';
import type { Focus } from './Statement';
import './Attention.css';

const RECEIPT_BATCH = 30;
const RECEIPT_KINDS = new Set(['expense', 'salary', 'supplier_payment', 'person_loan', 'credit_purchase']);

export default function Attention({ book, dashboard, role, open, goto, refresh, say, onMissingCount }: {
  book: LoadedBook;
  dashboard: EvidenceDashboard | null;
  role: 'owner' | 'entry';
  open: (focus: Focus) => void;
  goto: (view: 'approvals' | 'files') => void;
  refresh: () => Promise<void>;
  say: (text: string, bad?: boolean) => void;
  onMissingCount: (count: number) => void;
}) {
  const [missingEvidence, setMissingEvidence] = useState<EvidenceActivity[]>([]);
  const [checkingEvidence, setCheckingEvidence] = useState(false);
  const [evidenceEpoch, setEvidenceEpoch] = useState(0);
  const [evidenceLimit, setEvidenceLimit] = useState(RECEIPT_BATCH);
  const [busy, setBusy] = useState('');

  const pendingApprovals = dashboard?.approvals.filter((item) => item.status === 'pending') ?? [];
  const transfers = dashboard?.pendingTransfers ?? [];
  const reminders = book.reminders.filter((item) => !item.settled);
  const receiptsWaiting = book.projects.flatMap((project) => receiptsNotInCash(book, project.id));
  const unread = dashboard?.notifications.filter((item) => !item.read_at) ?? [];

  // Receipt evidence is checked only while this hub is open. Start with a small
  // batch for speed, then let the user expand the scan without a background
  // polling storm. This covers owner-entered and delegated cash activity alike.
  const allEvidenceCandidates = useMemo(() => {
    const recentById = new Map((dashboard?.recentActivity ?? []).map((item) => [item.id, item]));
    return [...book.entries]
      .reverse()
      .filter((entry) => !entry.voided && RECEIPT_KINDS.has(entry.kind))
      .map((entry): EvidenceActivity => {
        const dashboardEntry = recentById.get(entry.id);
        const accountId = entry.accountId ?? entry.toAccountId ?? null;
        return {
          id: entry.id,
          occurred_on: entry.occurredOn,
          amount: entry.amount,
          purpose: entry.purpose || entry.raw,
          kind: entry.kind,
          actor_email: dashboardEntry?.actor_email,
          account_name: dashboardEntry?.account_name
            ?? (accountId ? book.accounts.find((account) => account.id === accountId)?.name : undefined),
          created_at: entry.createdAt,
        };
      });
  }, [book.entries, book.accounts, dashboard?.recentActivity]);

  const evidenceCandidates = useMemo(
    () => allEvidenceCandidates.slice(0, evidenceLimit),
    [allEvidenceCandidates, evidenceLimit],
  );
  const candidateKey = evidenceCandidates.map((item) => item.id).join('|');

  useEffect(() => {
    let cancelled = false;
    if (!candidateKey) {
      setMissingEvidence([]);
      setCheckingEvidence(false);
      return () => { cancelled = true; };
    }

    setCheckingEvidence(true);
    Promise.all(evidenceCandidates.map(async (item) => {
      try {
        const evidence = await api.evidenceForEntry(item.id);
        return evidence.files.length === 0 ? item : null;
      } catch {
        // A temporary evidence lookup failure is not proof that a receipt is missing.
        return null;
      }
    })).then((items) => {
      if (!cancelled) setMissingEvidence(items.filter((item): item is EvidenceActivity => !!item));
    }).finally(() => {
      if (!cancelled) setCheckingEvidence(false);
    });

    return () => { cancelled = true; };
  }, [candidateKey, evidenceEpoch]);

  useEffect(() => onMissingCount(missingEvidence.length), [missingEvidence.length, onMissingCount]);

  const total = pendingApprovals.length + transfers.length + reminders.length + receiptsWaiting.length + missingEvidence.length;
  const checkedEvidence = Math.min(evidenceLimit, allEvidenceCandidates.length);
  const hasOlderEvidence = checkedEvidence < allEvidenceCandidates.length;

  const after = async (key: string, work: () => Promise<unknown>, done: string, recheckEvidence = false) => {
    setBusy(key);
    try {
      await work();
      await refresh();
      if (recheckEvidence) setEvidenceEpoch((value) => value + 1);
      say(done);
    } catch (error) {
      say((error as Error).message, true);
    } finally {
      setBusy('');
    }
  };

  const decide = async (id: string, status: 'approved' | 'rejected') => {
    const label = status === 'approved' ? 'Approve' : 'Reject';
    const note = window.prompt(`${label} note (optional)`) ?? '';
    await after(`approval:${id}`, () => api.decideApproval(id, status, note), `Request ${status}.`);
  };

  const transferAction = async (id: string, action: 'confirm' | 'reject') => {
    await after(
      `transfer:${id}`,
      () => action === 'confirm' ? api.confirmTransfer(id) : api.rejectTransfer(id),
      action === 'confirm' ? 'Money received and posted.' : 'Transfer marked as not received.',
    );
  };

  const addEvidence = async (entry: EvidenceActivity, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await after(`evidence:${entry.id}`, () => api.uploadEvidence(entry.id, file), 'Receipt added.', true);
  };

  const refreshHub = async () => {
    setBusy('refresh');
    try {
      await refresh();
      setEvidenceEpoch((value) => value + 1);
    } catch (error) {
      say((error as Error).message, true);
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <div className="dhead attention-head">
        <div>
          <h2>Needs attention</h2>
          <p className="muted">One place for decisions, handoffs, missing proof, reminders, and money still in limbo.</p>
        </div>
        <button className="btn ghost small" disabled={busy === 'refresh'} onClick={() => void refreshHub()}>
          {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="attention-summary" aria-label="Attention summary">
        <Summary label="Open" value={total} strong />
        <Summary label="Approvals" value={pendingApprovals.length} />
        <Summary label="Transfers" value={transfers.length} />
        <Summary label="Missing receipts" value={missingEvidence.length} loading={checkingEvidence} />
        <Summary label="Reminders" value={reminders.length + receiptsWaiting.length} />
      </div>

      {total === 0 && !checkingEvidence && (
        <Card><div className="attention-clear"><b>All clear.</b><span>Nothing currently needs a decision or follow-up.</span></div></Card>
      )}

      {(pendingApprovals.length > 0 || dashboard === null) && (
        <Card title="Approval requests" aside={pendingApprovals.length ? `${pendingApprovals.length} waiting` : undefined}>
          {dashboard === null ? <Empty>Approval data is temporarily unavailable.</Empty> : pendingApprovals.map((approval) => (
            <AttentionRow
              key={approval.id}
              title={approval.request_text}
              sub={[approval.requester_email, approval.account_name, approval.created_at ? new Date(approval.created_at).toLocaleString() : ''].filter(Boolean).join(' · ')}
              value={approval.amount == null ? undefined : money(approval.amount)}
            >
              {role === 'owner' ? (
                <>
                  <button className="btn small" disabled={busy === `approval:${approval.id}`} onClick={() => void decide(approval.id, 'approved')}>Approve</button>
                  <button className="btn ghost small danger" disabled={busy === `approval:${approval.id}`} onClick={() => void decide(approval.id, 'rejected')}>Reject</button>
                </>
              ) : <span className="chip">Waiting for owner</span>}
            </AttentionRow>
          ))}
        </Card>
      )}

      {transfers.length > 0 && (
        <Card title={role === 'entry' ? 'Money waiting for confirmation' : 'Transfers waiting for receipt'} aside={`${transfers.length} pending`}>
          {transfers.map((transfer) => (
            <AttentionRow
              key={transfer.id}
              title={transfer.purpose || 'Cash handoff'}
              sub={`${transfer.from_account_name} → ${transfer.to_account_name}${transfer.recipient_email ? ` · ${transfer.recipient_email}` : ''}`}
              value={money(transfer.amount)}
            >
              {role === 'entry' ? (
                <>
                  <button className="btn small" disabled={busy === `transfer:${transfer.id}`} onClick={() => void transferAction(transfer.id, 'confirm')}>I received it</button>
                  <button className="btn ghost small danger" disabled={busy === `transfer:${transfer.id}`} onClick={() => void transferAction(transfer.id, 'reject')}>Not received</button>
                </>
              ) : <button className="btn ghost small" onClick={() => goto('approvals')}>Open details</button>}
            </AttentionRow>
          ))}
        </Card>
      )}

      {(allEvidenceCandidates.length > 0 || checkingEvidence || missingEvidence.length > 0) && (
        <Card title="Missing receipts" aside={checkingEvidence ? `checking ${checkedEvidence}…` : `${missingEvidence.length} missing · ${checkedEvidence} checked`}>
          {checkingEvidence && missingEvidence.length === 0 && <Empty>Checking cash-out activity for receipt evidence…</Empty>}
          {!checkingEvidence && missingEvidence.length === 0 && <Empty>No missing receipt evidence in the checked activity.</Empty>}
          {missingEvidence.map((entry) => (
            <AttentionRow
              key={entry.id}
              title={entry.purpose || 'Cash expense'}
              sub={[entry.actor_email, entry.account_name, entry.occurred_on ? shortDate(entry.occurred_on) : ''].filter(Boolean).join(' · ')}
              value={entry.amount == null ? undefined : money(entry.amount)}
            >
              <label className={`btn ghost small attention-upload${busy === `evidence:${entry.id}` ? ' disabled' : ''}`}>
                {busy === `evidence:${entry.id}` ? 'Adding…' : 'Add receipt'}
                <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={busy === `evidence:${entry.id}`} onChange={(event) => void addEvidence(entry, event)} />
              </label>
              {role === 'owner' && <button className="btn ghost small" onClick={() => goto('files')}>Files</button>}
            </AttentionRow>
          ))}
          {hasOlderEvidence && (
            <div className="attention-toolbar">
              <button className="btn ghost small" disabled={checkingEvidence} onClick={() => setEvidenceLimit((value) => value + RECEIPT_BATCH)}>
                Check {Math.min(RECEIPT_BATCH, allEvidenceCandidates.length - checkedEvidence)} older entries
              </button>
            </div>
          )}
        </Card>
      )}

      {reminders.length > 0 && (
        <Card title="Reminders" aside={`${reminders.length} open`}>
          {reminders.map((reminder) => (
            <AttentionRow
              key={reminder.id}
              title={reminder.what}
              sub={[book.accounts.find((account) => account.id === reminder.accountId)?.name, reminder.note, 'Allocated, not paid'].filter(Boolean).join(' · ')}
              value={money(reminder.amount)}
            >
              <button className="btn ghost small" disabled={busy === `reminder:${reminder.id}`} onClick={() => void after(
                `reminder:${reminder.id}`,
                () => api.clearReminder(reminder.id),
                'Reminder cleared.',
              )}>Mark done</button>
            </AttentionRow>
          ))}
        </Card>
      )}

      {receiptsWaiting.length > 0 && (
        <Card title="Recorded receipts not in cash" aside={`${receiptsWaiting.length} waiting`}>
          {receiptsWaiting.map((receipt) => {
            const project = book.projects.find((item) => item.id === receipt.projectId);
            return (
              <AttentionRow
                key={receipt.id}
                title={project?.name ?? 'Project receipt'}
                sub={`Recorded, but no account has received it yet${receipt.occurredOn ? ` · ${shortDate(receipt.occurredOn)}` : ''}`}
                value={money(receipt.amount)}
              >
                {project && <button className="btn ghost small" onClick={() => open({ type: 'project', id: project.id })}>Open project</button>}
              </AttentionRow>
            );
          })}
        </Card>
      )}

      {unread.length > 0 && (
        <Card title="Updates" aside={`${unread.length} unread`}>
          <div className="attention-toolbar">
            <button className="btn ghost small" onClick={() => void after('notifications', api.markAllNotificationsRead, 'Updates marked read.')}>Mark all read</button>
          </div>
          {unread.slice(0, 20).map((notification) => (
            <AttentionRow key={notification.id} title={notification.title} sub={notification.body}>
              <button className="btn ghost small" disabled={busy === `notification:${notification.id}`} onClick={() => void after(
                `notification:${notification.id}`,
                () => api.markNotificationRead(notification.id),
                'Update marked read.',
              )}>Mark read</button>
            </AttentionRow>
          ))}
        </Card>
      )}
    </>
  );
}

function Summary({ label, value, strong, loading }: { label: string; value: number; strong?: boolean; loading?: boolean }) {
  return (
    <div className={`attention-stat${strong ? ' strong' : ''}`}>
      <span>{label}</span>
      <b className="num">{loading ? '…' : value}</b>
    </div>
  );
}

function AttentionRow({ title, sub, value, children }: {
  title: string;
  sub?: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="attention-row">
      <div className="attention-copy">
        <b>{title}</b>
        {sub && <small>{sub}</small>}
      </div>
      {value && <strong className="num attention-value">{value}</strong>}
      {children && <div className="attention-actions">{children}</div>}
    </div>
  );
}

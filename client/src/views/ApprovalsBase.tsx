import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Card, Empty } from '../ui';
import './Approvals.css';

interface MeUser { id: string; email: string; role: 'owner' | 'entry' }
interface Account { id: string; name: string; businessId: string; balance: number; todayIn?: number; todayOut?: number }
interface Delegate { id: string; email: string; accountIds: string[] }
interface Notification { id: string; title: string; body: string; read_at: string | null; created_at: string }
interface PendingTransfer {
  id: string; amount: number; purpose: string; from_account_id: string; to_account_id: string;
  from_account_name: string; to_account_name: string; recipient_email?: string; created_at: string;
}
interface Approval {
  id: string; request_text: string; amount: number | null; status: 'pending' | 'approved' | 'rejected';
  requester_email?: string; account_name?: string; review_note?: string; created_at: string;
}
interface Activity {
  id: string; occurred_on: string; amount: number; purpose: string; account_name: string;
  actor_email?: string; kind?: string;
}
interface OwnerDashboard {
  mode: 'owner'; accounts: Account[]; delegates: Delegate[]; pendingTransfers: PendingTransfer[];
  approvals: Approval[]; recentActivity: Activity[]; notifications: Notification[];
}
interface EntryDashboard {
  mode: 'entry'; accounts: Account[]; pendingTransfers: PendingTransfer[]; approvals: Approval[];
  recentActivity: Activity[]; notifications: Notification[];
}
type Dashboard = OwnerDashboard | EntryDashboard;
type OwnerSection = 'access' | 'requests' | 'transfers' | 'updates';
type EntrySection = 'cash' | 'incoming' | 'ask' | 'activity' | 'requests' | 'updates';
interface ApprovalNavItem { id: string; label: string; count?: number }

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-book': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) as { error?: string } : {};
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

async function upload(file: File, query: string): Promise<void> {
  const res = await fetch(`/api/delegation/attachments?${query}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-book': '1',
      'x-file-name': encodeURIComponent(file.name),
    },
    body: file,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) as { error?: string } : {};
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
}

const dollars = (n: number) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (s: string) => new Date(s).toLocaleString();

export default function Approvals({ me, say }: { me: MeUser; say: (text: string, bad?: boolean) => void }) {
  const [data, setData] = useState<Dashboard | null>(null);

  const load = async () => {
    try { setData(await request<Dashboard>('/delegation/dashboard')); }
    catch (e) { say((e as Error).message, true); }
  };

  useEffect(() => { void load(); }, [me.id]);

  return (
    <>
      <div className="dhead approvals-head">
        <div>
          <h2>{me.role === 'owner' ? 'Approvals' : 'My wallet'}</h2>
          <p className="muted">{me.role === 'owner'
            ? 'Manage account access and review approvals.'
            : 'Your assigned cash, incoming handoffs, requests and recent activity.'}</p>
        </div>
        <button className="btn ghost small" onClick={() => void load()}>Refresh</button>
      </div>

      {!data ? <Card><Empty>Reading…</Empty></Card>
        : data.mode === 'owner'
          ? <OwnerView data={data} reload={load} say={say} />
          : <EntryView data={data} reload={load} say={say} />}
    </>
  );
}

function OwnerView({ data, reload, say }: { data: OwnerDashboard; reload: () => Promise<void>; say: (t: string, bad?: boolean) => void }) {
  const pending = data.approvals.filter((a) => a.status === 'pending');
  const decided = data.approvals.filter((a) => a.status !== 'pending');
  const assigned = useMemo(() => new Set(data.delegates.flatMap((d) => d.accountIds)), [data.delegates]);
  const unread = data.notifications.filter((n) => !n.read_at).length;
  const [active, setActive] = useState<OwnerSection>(() => pending.length ? 'requests' : data.pendingTransfers.length ? 'transfers' : 'access');
  const [showHistory, setShowHistory] = useState(false);
  const nav: ApprovalNavItem[] = [
    { id: 'requests', label: 'Requests', count: pending.length },
    { id: 'access', label: 'Access', count: data.delegates.length },
    ...(data.pendingTransfers.length ? [{ id: 'transfers', label: 'Transfers', count: data.pendingTransfers.length }] : []),
    ...(data.notifications.length ? [{ id: 'updates', label: 'Updates', count: unread }] : []),
  ];

  return (
    <>
      <ApprovalMobileNav items={nav} active={active} onChange={(id) => setActive(id as OwnerSection)} />

      <div className={`approval-section${active === 'access' ? ' is-active' : ''}`} data-approval-section="access">
        <Card title="Account access" aside={`${assigned.size} assigned`}>
          <div className="approval-card-note">Choose which cash accounts each person can use.</div>
          {data.delegates.length === 0 ? <Empty>No entry-only users yet. Add them from Access first.</Empty>
            : <div className="approval-user-list">{data.delegates.map((d) => (
                <Assignment key={d.id} delegate={d} accounts={data.accounts} reload={reload} say={say} />
              ))}</div>}
        </Card>
      </div>

      <div className={`approval-section${active === 'requests' ? ' is-active' : ''}`} data-approval-section="requests">
        <Card title="Approval requests" aside={pending.length ? `${pending.length} waiting` : undefined}>
          {data.approvals.length === 0 ? <Empty>No approval requests.</Empty> : (
            <>
              {decided.length > 0 && (
                <div className="approval-history-toggle">
                  <button className="btn ghost small" type="button" onClick={() => setShowHistory((value) => !value)}>
                    {showHistory ? 'Hide decided requests' : `Show decided requests (${decided.length})`}
                  </button>
                </div>
              )}
              {data.approvals.map((a) => (
                <div className={`approval-row${a.status === 'pending' ? '' : ` approval-history-row${showHistory ? ' is-shown' : ''}`}`} key={a.id}>
                  <div className="approval-main">
                    <b>{a.requester_email || 'Entry user'}</b>
                    <span>{a.request_text}</span>
                    <small>{a.account_name || 'No account'}{a.amount ? ` · ${dollars(a.amount)}` : ''} · {when(a.created_at)}</small>
                    {a.review_note && <small>Note: {a.review_note}</small>}
                    <EvidenceLinks requestId={a.id} />
                  </div>
                  {a.status === 'pending'
                    ? <div className="approval-actions">
                        <Decision id={a.id} status="approved" label="Approve" reload={reload} say={say} />
                        <Decision id={a.id} status="rejected" label="Reject" reload={reload} say={say} />
                      </div>
                    : <Status value={a.status} />}
                </div>
              ))}
            </>
          )}
        </Card>
      </div>

      {data.pendingTransfers.length > 0 && (
        <div className={`approval-section${active === 'transfers' ? ' is-active' : ''}`} data-approval-section="transfers">
          <Card title="Waiting for receipt confirmation">
            {data.pendingTransfers.map((t) => (
              <div className="approval-row" key={t.id}>
                <div className="approval-main">
                  <b>{dollars(t.amount)} → {t.recipient_email || t.to_account_name}</b>
                  <span>{t.from_account_name} → {t.to_account_name}</span>
                  <small>{t.purpose}</small>
                </div>
              </div>
            ))}
          </Card>
        </div>
      )}

      {data.notifications.length > 0 && (
        <div className={`approval-section${active === 'updates' ? ' is-active' : ''}`} data-approval-section="updates">
          <Notifications items={data.notifications} reload={reload} say={say} />
        </div>
      )}
    </>
  );
}

function Assignment({ delegate, accounts, reload, say }: {
  delegate: Delegate; accounts: Account[]; reload: () => Promise<void>; say: (t: string, bad?: boolean) => void;
}) {
  const [selected, setSelected] = useState<string[]>(delegate.accountIds);
  useEffect(() => setSelected(delegate.accountIds), [delegate.accountIds.join('|')]);

  const originalKey = [...delegate.accountIds].sort().join('|');
  const selectedKey = [...selected].sort().join('|');
  const changed = originalKey !== selectedKey;
  const initial = delegate.email.trim().charAt(0).toUpperCase() || 'U';
  const countLabel = `${selected.length} account${selected.length === 1 ? '' : 's'} selected`;

  const save = async () => {
    if (!changed) return;
    try {
      await request(`/delegation/users/${delegate.id}/accounts`, 'PUT', { accountIds: selected });
      await reload();
      say(`Account access updated for ${delegate.email}.`);
    } catch (e) { say((e as Error).message, true); }
  };

  return (
    <div className="approval-user-card">
      <div className="approval-user-head">
        <div className="approval-avatar">{initial}</div>
        <div className="approval-user-copy">
          <b>{delegate.email}</b>
          <small>{countLabel}</small>
        </div>
        <button className="btn small" disabled={!changed} onClick={save}>Save</button>
      </div>

      {accounts.length === 0 ? <Empty>No cash accounts available yet.</Empty> : (
        <div className="approval-checks">
          {accounts.map((a) => {
            const checked = selected.includes(a.id);
            return (
              <label key={a.id} className={checked ? 'selected' : ''}>
                <input type="checkbox" checked={checked} onChange={(e) => {
                  setSelected(e.target.checked ? [...selected, a.id] : selected.filter((id) => id !== a.id));
                }} />
                <span>{a.name}</span>
                <small>{dollars(a.balance)}</small>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Decision({ id, status, label, reload, say }: {
  id: string; status: 'approved' | 'rejected'; label: string; reload: () => Promise<void>; say: (t: string, bad?: boolean) => void;
}) {
  const go = async () => {
    const note = window.prompt(`${label} note (optional)`) ?? '';
    try {
      await request(`/delegation/approvals/${id}/decision`, 'POST', { status, note });
      await reload();
      say(`Request ${status}.`);
    } catch (e) { say((e as Error).message, true); }
  };
  return <button className={`btn ghost small${status === 'rejected' ? ' danger' : ''}`} onClick={go}>{label}</button>;
}

function EntryView({ data, reload, say }: { data: EntryDashboard; reload: () => Promise<void>; say: (t: string, bad?: boolean) => void }) {
  const unread = data.notifications.filter((n) => !n.read_at).length;
  const pendingRequests = data.approvals.filter((a) => a.status === 'pending').length;
  const [active, setActive] = useState<EntrySection>(() => data.pendingTransfers.length ? 'incoming' : 'cash');
  const nav: ApprovalNavItem[] = [
    { id: 'cash', label: 'Cash', count: data.accounts.length },
    { id: 'incoming', label: 'Incoming', count: data.pendingTransfers.length },
    { id: 'ask', label: 'Ask owner' },
    { id: 'activity', label: 'Activity', count: data.recentActivity.length },
    { id: 'requests', label: 'Requests', count: pendingRequests },
    { id: 'updates', label: 'Updates', count: unread },
  ];

  return (
    <>
      <ApprovalMobileNav items={nav} active={active} onChange={(id) => setActive(id as EntrySection)} />

      <div className={`approval-section${active === 'cash' ? ' is-active' : ''}`} data-approval-section="cash">
        <Card title="Available cash">
          {data.accounts.length === 0 ? <Empty>The owner has not assigned an account to you yet.</Empty> : data.accounts.map((a) => (
            <div className="approval-row" key={a.id}>
              <div className="approval-main">
                <b>{a.name}</b>
                <small>Today: +{dollars(a.todayIn || 0)} · −{dollars(a.todayOut || 0)}</small>
              </div>
              <strong className="num approval-balance">{dollars(a.balance)}</strong>
            </div>
          ))}
          <div className="approval-note">Expenses are blocked automatically when there is not enough money.</div>
        </Card>
      </div>

      <div className={`approval-section${active === 'incoming' ? ' is-active' : ''}`} data-approval-section="incoming">
        <Card title="Money waiting for you to confirm">
          {data.pendingTransfers.length === 0 ? <Empty>No transfer is waiting.</Empty> : data.pendingTransfers.map((t) => (
            <div className="approval-row" key={t.id}>
              <div className="approval-main">
                <b>{dollars(t.amount)} into {t.to_account_name}</b>
                <span>{t.purpose}</span>
                <small>Confirm only after you actually receive it.</small>
              </div>
              <div className="approval-actions">
                <button className="btn small" onClick={() => void actTransfer(t.id, 'confirm', reload, say)}>I received it</button>
                <button className="btn ghost small danger" onClick={() => void actTransfer(t.id, 'reject', reload, say)}>Not received</button>
              </div>
            </div>
          ))}
        </Card>
      </div>

      <div className={`approval-section${active === 'ask' ? ' is-active' : ''}`} data-approval-section="ask">
        <ApprovalForm accounts={data.accounts} reload={reload} say={say} />
      </div>

      <div className={`approval-section${active === 'activity' ? ' is-active' : ''}`} data-approval-section="activity">
        <Card title="My recent cash activity">
          {data.recentActivity.length === 0 ? <Empty>No activity yet.</Empty> : data.recentActivity.slice(0, 40).map((a) => (
            <div className="approval-row" key={a.id}>
              <div className="approval-main">
                <b>{a.kind === 'transfer' ? '+' : '−'}{dollars(a.amount)} · {a.account_name}</b>
                <span>{a.purpose || a.kind || 'Entry'}</span>
                <small>{a.occurred_on}</small>
                <EvidenceLinks entryId={a.id} />
              </div>
              {a.kind !== 'transfer' && <FileButton label="Add receipt" onFile={(f) => void uploadAndReload(f, `entryId=${encodeURIComponent(a.id)}`, reload, say)} />}
            </div>
          ))}
        </Card>
      </div>

      <div className={`approval-section${active === 'requests' ? ' is-active' : ''}`} data-approval-section="requests">
        <Card title="My approval requests">
          {data.approvals.length === 0 ? <Empty>No requests yet.</Empty> : data.approvals.map((a) => (
            <div className="approval-row" key={a.id}>
              <div className="approval-main">
                <b>{a.request_text}</b>
                <small>{a.account_name || ''}{a.amount ? ` · ${dollars(a.amount)}` : ''}</small>
                <EvidenceLinks requestId={a.id} />
              </div>
              <Status value={a.status} />
            </div>
          ))}
        </Card>
      </div>

      <div className={`approval-section${active === 'updates' ? ' is-active' : ''}`} data-approval-section="updates">
        <Notifications items={data.notifications} reload={reload} say={say} />
      </div>
    </>
  );
}

function ApprovalMobileNav({ items, active, onChange }: { items: ApprovalNavItem[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="approval-mobile-nav" role="tablist" aria-label="Approval workflows">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={active === item.id}
          className={active === item.id ? 'is-active' : ''}
          onClick={() => onChange(item.id)}
        >
          <span>{item.label}</span>
          {item.count != null && <b className="num">{item.count}</b>}
        </button>
      ))}
    </div>
  );
}

async function actTransfer(id: string, action: 'confirm' | 'reject', reload: () => Promise<void>, say: (t: string, bad?: boolean) => void) {
  try {
    await request(`/delegation/transfers/${id}/${action}`, 'POST');
    await reload();
    say(action === 'confirm' ? 'Money received and posted.' : 'Transfer marked as not received.');
  } catch (e) { say((e as Error).message, true); }
}

function ApprovalForm({ accounts, reload, say }: { accounts: Account[]; reload: () => Promise<void>; say: (t: string, bad?: boolean) => void }) {
  const [text, setText] = useState('');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id || '');
  const [file, setFile] = useState<File | null>(null);
  useEffect(() => { if (!accountId && accounts[0]) setAccountId(accounts[0].id); }, [accounts.length]);

  const send = async () => {
    try {
      const made = await request<{ id: string }>('/delegation/approvals', 'POST', {
        text, accountId, amount: amount ? Number(amount) : null,
      });
      if (file) await upload(file, `requestId=${encodeURIComponent(made.id)}`);
      setText(''); setAmount(''); setFile(null);
      await reload();
      say('Approval request sent.');
    } catch (e) { say((e as Error).message, true); }
  };

  return (
    <Card title="Ask the owner for approval">
      <div className="form approval-form">
        <div className="f approval-wide">
          <label>Request</label>
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="I ordered 10 tons of bricks…" />
        </div>
        <div className="f">
          <label>Account</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div className="f">
          <label>Estimated amount</label>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="optional" />
        </div>
        <label className="approval-file">Photo / quote / PDF<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
        <button className="btn" disabled={!text.trim() || !accountId} onClick={send}>Send for approval</button>
      </div>
    </Card>
  );
}

function Notifications({ items, reload, say }: { items: Notification[]; reload: () => Promise<void>; say: (t: string, bad?: boolean) => void }) {
  const unread = items.filter((n) => !n.read_at);
  const markAll = async () => {
    try { await request('/delegation/notifications/read-all', 'POST'); await reload(); }
    catch (e) { say((e as Error).message, true); }
  };
  return (
    <Card title="Notifications" aside={unread.length ? `${unread.length} new` : undefined}>
      {unread.length > 0 && <div className="approval-toolbar"><button className="btn ghost small" onClick={markAll}>Mark all read</button></div>}
      {items.length === 0 ? <Empty>No notifications yet.</Empty> : items.slice(0, 30).map((n) => (
        <button className={`approval-row approval-notification${n.read_at ? ' read' : ''}`} key={n.id} onClick={async () => {
          if (!n.read_at) {
            try { await request(`/delegation/notifications/${n.id}/read`, 'POST'); await reload(); }
            catch (e) { say((e as Error).message, true); }
          }
        }}>
          <div className="approval-main">
            <b>{n.title}</b>
            <span>{n.body}</span>
            <small>{when(n.created_at)}</small>
          </div>
        </button>
      ))}
    </Card>
  );
}

function EvidenceLinks({ entryId, requestId }: { entryId?: string; requestId?: string }) {
  const [files, setFiles] = useState<Array<{ id: string; filename: string }>>([]);
  useEffect(() => {
    const q = entryId ? `entryId=${encodeURIComponent(entryId)}` : requestId ? `requestId=${encodeURIComponent(requestId)}` : '';
    if (!q) return;
    request<{ files: Array<{ id: string; filename: string }> }>(`/delegation/attachments?${q}`)
      .then((r) => setFiles(r.files)).catch(() => setFiles([]));
  }, [entryId, requestId]);
  if (!files.length) return null;
  return <small className="approval-evidence">Evidence: {files.map((f, i) => <span key={f.id}>{i ? ' · ' : ''}<a href={`/api/delegation/attachments/${f.id}`} target="_blank" rel="noreferrer">{f.filename}</a></span>)}</small>;
}

function FileButton({ label, onFile }: { label: string; onFile: (file: File) => void }) {
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onFile(f);
    e.target.value = '';
  };
  return <label className="btn ghost small approval-file-btn">{label}<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={pick} /></label>;
}

async function uploadAndReload(file: File, query: string, reload: () => Promise<void>, say: (t: string, bad?: boolean) => void) {
  try { await upload(file, query); await reload(); say('Evidence added.'); }
  catch (e) { say((e as Error).message, true); }
}

function Status({ value }: { value: string }) {
  return <span className={`chip approval-status ${value}`}>{value}</span>;
}

import { useEffect, useMemo, useState, type CSSProperties, type ChangeEvent } from 'react';
import { createRoot } from 'react-dom/client';

interface Me { user: { id: string; email: string; role: 'owner' | 'entry' } | null }
interface Account { id: string; name: string; businessId: string; balance: number; todayIn?: number; todayOut?: number }
interface Delegate { id: string; email: string; accountIds: string[] }
interface Notification { id: string; title: string; body: string; read_at: string | null; created_at: string; related_type?: string; related_id?: string }
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
  actor_email?: string; kind?: string; created_by?: string;
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

const money = (n: number) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (s: string) => new Date(s).toLocaleString();

function DelegationPanel() {
  const [me, setMe] = useState<Me['user']>(null);
  const [data, setData] = useState<Dashboard | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  const load = async (quiet = false) => {
    try {
      const who = await request<Me>('/me');
      setMe(who.user);
      if (!who.user) { setData(null); return; }
      setData(await request<Dashboard>('/delegation/dashboard'));
      if (!quiet) setError('');
    } catch (e) {
      if (!quiet) setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(true); }, 12_000);
    return () => window.clearInterval(timer);
  }, []);

  const unread = data?.notifications.filter((n) => !n.read_at).length ?? 0;
  if (!me) return null;

  return (
    <>
      <button style={launcher} onClick={() => setOpen(true)} aria-label="Open wallet and approvals">
        {me.role === 'owner' ? 'Approvals' : 'My wallet'}
        {unread > 0 && <span style={badge}>{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div style={shade} onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div style={panel}>
            <header style={head}>
              <div>
                <b style={{ fontSize: 18 }}>{me.role === 'owner' ? 'Access & approvals' : 'My cash wallet'}</b>
                <div style={muted}>{me.email}</div>
              </div>
              <button style={closeBtn} onClick={() => setOpen(false)}>×</button>
            </header>
            {error && <div style={errorBox}>{error}</div>}
            {!data ? <div style={pad}>Loading…</div>
              : data.mode === 'owner'
                ? <OwnerView data={data} reload={() => load()} setError={setError} />
                : <EntryView data={data} reload={() => load()} setError={setError} />}
          </div>
        </div>
      )}
    </>
  );
}

function OwnerView({ data, reload, setError }: { data: OwnerDashboard; reload: () => Promise<void>; setError: (s: string) => void }) {
  const assigned = useMemo(() => new Set(data.delegates.flatMap((d) => d.accountIds)), [data.delegates]);
  const pending = data.approvals.filter((a) => a.status === 'pending');

  return (
    <div style={body}>
      <section style={section}>
        <div style={sectionHeaderRow}>
          <div>
            <h3 style={{ ...sectionTitle, marginBottom: 3 }}>Account access</h3>
            <div style={muted}>Choose which cash accounts each person can use.</div>
          </div>
          <span style={summaryPill}>{assigned.size} assigned</span>
        </div>

        {data.delegates.length === 0 ? <Empty text="No entry-only users yet. Add them from Access first." />
          : <div style={delegateList}>{data.delegates.map((d) => (
              <Assignment key={d.id} delegate={d} accounts={data.accounts} reload={reload} setError={setError} />
            ))}</div>}
      </section>

      <Section title={`Approval requests${pending.length ? ` · ${pending.length} waiting` : ''}`}>
        {data.approvals.length === 0 ? <CompactEmpty text="No approval requests." /> : data.approvals.map((a) => (
          <div key={a.id} style={rowCard}>
            <div style={{ flex: 1 }}>
              <b>{a.requester_email}</b>
              <div>{a.request_text}</div>
              <div style={muted}>{a.account_name || 'No account'}{a.amount ? ` · ${money(a.amount)}` : ''} · {when(a.created_at)}</div>
              {a.review_note && <div style={muted}>Note: {a.review_note}</div>}
              <EvidenceLinks requestId={a.id} />
            </div>
            {a.status === 'pending'
              ? <div style={actions}>
                  <Decision id={a.id} status="approved" label="Approve" reload={reload} setError={setError} />
                  <Decision id={a.id} status="rejected" label="Reject" reload={reload} setError={setError} />
                </div>
              : <Status value={a.status} />}
          </div>
        ))}
      </Section>

      {data.pendingTransfers.length > 0 && (
        <Section title="Waiting for receipt confirmation">
          {data.pendingTransfers.map((t) => (
            <div key={t.id} style={rowCard}>
              <div><b>{money(t.amount)} → {t.recipient_email}</b><div>{t.from_account_name} → {t.to_account_name}</div><div style={muted}>{t.purpose}</div></div>
            </div>
          ))}
        </Section>
      )}

      {data.notifications.length > 0 && <Notifications items={data.notifications} reload={reload} />}
    </div>
  );
}

function Assignment({ delegate, accounts, reload, setError }: {
  delegate: Delegate; accounts: Account[]; reload: () => Promise<void>; setError: (s: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>(delegate.accountIds);
  useEffect(() => setSelected(delegate.accountIds), [delegate.accountIds.join('|')]);

  const originalKey = [...delegate.accountIds].sort().join('|');
  const selectedKey = [...selected].sort().join('|');
  const changed = originalKey !== selectedKey;
  const countLabel = `${selected.length} account${selected.length === 1 ? '' : 's'}`;
  const initial = delegate.email.trim().charAt(0).toUpperCase() || 'U';

  const save = async () => {
    if (!changed) return;
    try { await request(`/delegation/users/${delegate.id}/accounts`, 'PUT', { accountIds: selected }); await reload(); }
    catch (e) { setError((e as Error).message); }
  };

  return (
    <div style={delegateCard}>
      <div style={delegateHeader}>
        <div style={avatar}>{initial}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={delegateEmail}>{delegate.email}</div>
          <div style={muted}>{countLabel} selected</div>
        </div>
        <button
          style={{ ...compactPrimary, ...(changed ? {} : disabledButton) }}
          disabled={!changed}
          onClick={save}
        >
          Save
        </button>
      </div>

      {accounts.length === 0 ? <CompactEmpty text="No cash accounts available yet." /> : (
        <div style={accountGrid}>
          {accounts.map((a) => {
            const checked = selected.includes(a.id);
            return (
              <label key={a.id} style={{ ...accountChoice, ...(checked ? accountChoiceSelected : {}) }}>
                <input type="checkbox" checked={checked} onChange={(e) => {
                  setSelected(e.target.checked ? [...selected, a.id] : selected.filter((id) => id !== a.id));
                }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={accountName}>{a.name}</span>
                  <span style={accountBalance}>{money(a.balance)}</span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Decision({ id, status, label, reload, setError }: {
  id: string; status: 'approved' | 'rejected'; label: string; reload: () => Promise<void>; setError: (s: string) => void;
}) {
  const go = async () => {
    const note = window.prompt(`${label} note (optional)`) ?? '';
    try { await request(`/delegation/approvals/${id}/decision`, 'POST', { status, note }); await reload(); }
    catch (e) { setError((e as Error).message); }
  };
  return <button style={status === 'approved' ? primarySmall : secondarySmall} onClick={go}>{label}</button>;
}

function EntryView({ data, reload, setError }: { data: EntryDashboard; reload: () => Promise<void>; setError: (s: string) => void }) {
  return (
    <div style={body}>
      <Section title="Available cash">
        {data.accounts.length === 0 ? <Empty text="The owner has not assigned an account to you yet." /> : data.accounts.map((a) => (
          <div key={a.id} style={balanceCard}>
            <div><b>{a.name}</b><div style={muted}>Today: +{money(a.todayIn || 0)} · −{money(a.todayOut || 0)}</div></div>
            <strong style={{ fontSize: 24 }}>{money(a.balance)}</strong>
          </div>
        ))}
        <div style={muted}>Expenses are blocked automatically when there is not enough money. A balance of $0.00 cannot be spent.</div>
      </Section>

      <Section title="Money waiting for you to confirm">
        {data.pendingTransfers.length === 0 ? <Empty text="No transfer is waiting." /> : data.pendingTransfers.map((t) => (
          <div key={t.id} style={rowCard}>
            <div style={{ flex: 1 }}><b>{money(t.amount)} into {t.to_account_name}</b><div>{t.purpose}</div><div style={muted}>Confirm only after you actually receive it.</div></div>
            <div style={actions}>
              <button style={primarySmall} onClick={() => actTransfer(t.id, 'confirm', reload, setError)}>I received it</button>
              <button style={secondarySmall} onClick={() => actTransfer(t.id, 'reject', reload, setError)}>Not received</button>
            </div>
          </div>
        ))}
      </Section>

      <ApprovalForm accounts={data.accounts} reload={reload} setError={setError} />

      <Section title="My recent cash activity">
        {data.recentActivity.length === 0 ? <Empty text="No activity yet." /> : data.recentActivity.slice(0, 40).map((a) => (
          <div key={a.id} style={rowCard}>
            <div style={{ flex: 1 }}><b>{a.kind === 'transfer' ? '+' : '−'}{money(a.amount)} · {a.account_name}</b><div>{a.purpose || a.kind || 'Entry'}</div><div style={muted}>{a.occurred_on}</div><EvidenceLinks entryId={a.id} /></div>
            {a.kind !== 'transfer' && <FileButton label="Add receipt / photo" onFile={(f) => uploadAndReload(f, `entryId=${encodeURIComponent(a.id)}`, reload, setError)} />}
          </div>
        ))}
      </Section>

      <Section title="My approval requests">
        {data.approvals.length === 0 ? <Empty text="No requests yet." /> : data.approvals.map((a) => (
          <div key={a.id} style={rowCard}><div style={{ flex: 1 }}><b>{a.request_text}</b><div style={muted}>{a.account_name || ''}{a.amount ? ` · ${money(a.amount)}` : ''}</div><EvidenceLinks requestId={a.id} /></div><Status value={a.status} /></div>
        ))}
      </Section>

      <Notifications items={data.notifications} reload={reload} />
    </div>
  );
}

async function actTransfer(id: string, action: 'confirm' | 'reject', reload: () => Promise<void>, setError: (s: string) => void) {
  try { await request(`/delegation/transfers/${id}/${action}`, 'POST'); await reload(); }
  catch (e) { setError((e as Error).message); }
}

function ApprovalForm({ accounts, reload, setError }: { accounts: Account[]; reload: () => Promise<void>; setError: (s: string) => void }) {
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
      setText(''); setAmount(''); setFile(null); await reload();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <Section title="Ask the owner for approval">
      <div style={muted}>Example: “I ordered 10 tons of bricks for the site.” Add an estimated amount if you know it.</div>
      <label style={field}>Request<textarea style={{ ...input, minHeight: 78, resize: 'vertical' }} value={text} onChange={(e) => setText(e.target.value)} placeholder="I ordered 10 tons of bricks…" /></label>
      <div style={grid}>
        <label style={field}>Account<select style={input} value={accountId} onChange={(e) => setAccountId(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label style={field}>Estimated amount (optional)<input style={input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} /></label>
      </div>
      <label style={fileLabel}>Photo / quote / document (optional)<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
      <button style={primary} disabled={!text.trim() || !accountId} onClick={send}>Send for approval</button>
    </Section>
  );
}

function Notifications({ items, reload }: { items: Notification[]; reload: () => Promise<void> }) {
  const unread = items.filter((n) => !n.read_at);
  const markAll = async () => { await request('/delegation/notifications/read-all', 'POST'); await reload(); };
  return (
    <Section title={`Notifications${unread.length ? ` · ${unread.length} new` : ''}`}>
      {unread.length > 0 && <button style={secondarySmall} onClick={markAll}>Mark all read</button>}
      {items.length === 0 ? <Empty text="No notifications yet." /> : items.slice(0, 30).map((n) => (
        <div key={n.id} style={{ ...rowCard, opacity: n.read_at ? .68 : 1 }} onClick={async () => {
          if (!n.read_at) { await request(`/delegation/notifications/${n.id}/read`, 'POST'); await reload(); }
        }}>
          <div><b>{n.title}</b><div>{n.body}</div><div style={muted}>{when(n.created_at)}</div></div>
        </div>
      ))}
    </Section>
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
  return <div style={{ ...muted, marginTop: 5 }}>Evidence: {files.map((f, i) => <span key={f.id}>{i ? ' · ' : ''}<a href={`/api/delegation/attachments/${f.id}`} target="_blank" rel="noreferrer">{f.filename}</a></span>)}</div>;
}

function FileButton({ label, onFile }: { label: string; onFile: (file: File) => void }) {
  const pick = (e: ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; };
  return <label style={fileButton}>{label}<input style={{ display: 'none' }} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={pick} /></label>;
}

async function uploadAndReload(file: File, q: string, reload: () => Promise<void>, setError: (s: string) => void) {
  try { await upload(file, q); await reload(); } catch (e) { setError((e as Error).message); }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section style={section}><h3 style={sectionTitle}>{title}</h3>{children}</section>;
}
function Empty({ text }: { text: string }) { return <div style={{ ...muted, padding: '8px 0' }}>{text}</div>; }
function CompactEmpty({ text }: { text: string }) { return <div style={compactEmpty}>{text}</div>; }
function Status({ value }: { value: string }) { return <span style={{ ...statusPill, background: value === 'approved' ? '#dcfce7' : value === 'rejected' ? '#fee2e2' : '#fef3c7' }}>{value}</span>; }

const launcher: CSSProperties = { position: 'fixed', top: 14, right: 14, zIndex: 70, border: 0, borderRadius: 999, padding: '10px 16px', fontWeight: 800, cursor: 'pointer', background: '#111827', color: '#fff', boxShadow: '0 8px 28px rgba(0,0,0,.22)' };
const badge: CSSProperties = { marginLeft: 8, background: '#ef4444', color: '#fff', borderRadius: 999, padding: '2px 7px', fontSize: 11 };
const shade: CSSProperties = { position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(15,23,42,.62)', display: 'flex', justifyContent: 'flex-end' };
const panel: CSSProperties = { width: 'min(680px, 100vw)', height: '100%', overflow: 'auto', background: '#f8fafc', color: '#111827', boxShadow: '-12px 0 40px rgba(0,0,0,.25)' };
const head: CSSProperties = { position: 'sticky', top: 0, zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px', background: '#fff', borderBottom: '1px solid #e5e7eb' };
const closeBtn: CSSProperties = { border: 0, background: 'transparent', fontSize: 32, lineHeight: 1, cursor: 'pointer' };
const body: CSSProperties = { padding: 14, display: 'grid', gap: 12 };
const pad: CSSProperties = { padding: 24 };
const section: CSSProperties = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 14, boxShadow: '0 1px 4px rgba(15,23,42,.035)' };
const sectionTitle: CSSProperties = { margin: '0 0 10px', fontSize: 15 };
const sectionHeaderRow: CSSProperties = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 };
const summaryPill: CSSProperties = { flexShrink: 0, borderRadius: 999, padding: '5px 9px', background: '#f1f5f9', color: '#475569', fontSize: 11, fontWeight: 800 };
const delegateList: CSSProperties = { display: 'grid', gap: 9 };
const delegateCard: CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, background: '#fff' };
const delegateHeader: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
const avatar: CSSProperties = { width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flexShrink: 0, background: '#f1f5f9', color: '#334155', fontSize: 13, fontWeight: 900 };
const delegateEmail: CSSProperties = { fontSize: 13, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const accountGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 7, marginTop: 10 };
const accountChoice: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, border: '1px solid #e2e8f0', borderRadius: 10, padding: '9px 10px', cursor: 'pointer', background: '#fff' };
const accountChoiceSelected: CSSProperties = { borderColor: '#94a3b8', background: '#f8fafc' };
const accountName: CSSProperties = { display: 'block', fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const accountBalance: CSSProperties = { display: 'block', marginTop: 2, color: '#64748b', fontSize: 11 };
const compactPrimary: CSSProperties = { border: 0, borderRadius: 9, padding: '7px 11px', background: '#111827', color: '#fff', fontSize: 12, fontWeight: 800, cursor: 'pointer' };
const disabledButton: CSSProperties = { opacity: .42, cursor: 'default' };
const compactEmpty: CSSProperties = { marginTop: 8, borderRadius: 10, padding: '10px 11px', background: '#f8fafc', color: '#64748b', fontSize: 12 };
const rowCard: CSSProperties = { display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', padding: '11px 0', borderTop: '1px solid #eef2f7' };
const balanceCard: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '14px 0', borderTop: '1px solid #eef2f7' };
const muted: CSSProperties = { color: '#64748b', fontSize: 12 };
const errorBox: CSSProperties = { margin: 14, padding: 12, borderRadius: 10, background: '#fee2e2', color: '#991b1b' };
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 10 };
const field: CSSProperties = { display: 'grid', gap: 5, fontSize: 12, fontWeight: 700, marginBottom: 10 };
const input: CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 10, padding: '10px 11px', background: '#fff', color: '#111827', font: 'inherit' };
const primary: CSSProperties = { marginTop: 10, border: 0, borderRadius: 10, padding: '10px 14px', background: '#111827', color: '#fff', fontWeight: 800, cursor: 'pointer' };
const primarySmall: CSSProperties = { border: 0, borderRadius: 9, padding: '8px 11px', background: '#111827', color: '#fff', fontWeight: 800, cursor: 'pointer' };
const secondarySmall: CSSProperties = { border: '1px solid #cbd5e1', borderRadius: 9, padding: '8px 11px', background: '#fff', color: '#334155', fontWeight: 700, cursor: 'pointer' };
const actions: CSSProperties = { display: 'flex', gap: 7, flexWrap: 'wrap', justifyContent: 'flex-end' };
const fileLabel: CSSProperties = { display: 'grid', gap: 6, fontSize: 12, marginTop: 8 };
const fileButton: CSSProperties = { border: '1px solid #cbd5e1', borderRadius: 9, padding: '8px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' };
const statusPill: CSSProperties = { borderRadius: 999, padding: '5px 9px', fontSize: 11, fontWeight: 800, textTransform: 'capitalize' };

const host = document.createElement('div');
host.id = 'delegation-root';
document.body.appendChild(host);
createRoot(host).render(<DelegationPanel />);

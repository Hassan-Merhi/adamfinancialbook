import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, type EvidenceFile, type LoadedBook } from '../api';

interface LibraryItem extends EvidenceFile {
  source: 'entry' | 'approval';
  relatedId: string;
  relatedDate: string;
  description: string;
  amount: number | null;
  accountName: string;
  person: string;
  status: string;
}

interface Target {
  source: LibraryItem['source'];
  id: string;
  relatedDate: string;
  description: string;
  amount: number | null;
  accountName: string;
  person: string;
  status: string;
}

const money = (n: number) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const size = (n: number) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const day = (s: string) => s ? String(s).slice(0, 10) : '';
const isImage = (mime: string) => mime.startsWith('image/');

export default function Files({ book }: { book: LoadedBook }) {
  const [files, setFiles] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [source, setSource] = useState('all');
  const [account, setAccount] = useState('all');
  const [person, setPerson] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      setFiles([]);
      try {
        const [dashboard, users] = await Promise.all([api.evidenceDashboard(), api.users()]);
        if (cancelled) return;
        const emails = new Map(users.users.map((u) => [u.id, u.email]));
        const accountNames = new Map(book.accounts.map((a) => [a.id, a.name]));
        const targets: Target[] = [];

        for (const entry of book.entries) {
          if (entry.voided) continue;
          const accountId = entry.accountId ?? entry.toAccountId ?? null;
          targets.push({
            source: 'entry',
            id: entry.id,
            relatedDate: entry.occurredOn,
            description: entry.purpose || entry.raw || 'Book entry',
            amount: entry.amount,
            accountName: accountId ? accountNames.get(accountId) ?? '' : '',
            person: entry.createdBy ? emails.get(entry.createdBy) ?? '' : '',
            status: entry.kind,
          });
        }

        for (const request of dashboard.approvals ?? []) {
          targets.push({
            source: 'approval',
            id: request.id,
            relatedDate: day(request.created_at),
            description: request.request_text || 'Approval request',
            amount: request.amount,
            accountName: request.account_name ?? '',
            person: request.requester_email ?? '',
            status: request.status,
          });
        }

        setProgress({ done: 0, total: targets.length });
        if (!targets.length) {
          setLoading(false);
          return;
        }

        let cursor = 0;
        let completed = 0;
        const found: LibraryItem[] = [];
        const workers = Math.min(8, targets.length);
        const scan = async () => {
          while (!cancelled) {
            const index = cursor++;
            if (index >= targets.length) return;
            const target = targets[index];
            try {
              const response = target.source === 'entry'
                ? await api.evidenceForEntry(target.id)
                : await api.evidenceForRequest(target.id);
              for (const file of response.files) {
                found.push({
                  ...file,
                  source: target.source,
                  relatedId: target.id,
                  relatedDate: target.relatedDate,
                  description: target.description,
                  amount: target.amount,
                  accountName: target.accountName,
                  person: target.person,
                  status: target.status,
                });
              }
            } catch (e) {
              if (!cancelled) setError((e as Error).message);
            }
            completed += 1;
            if (!cancelled) setProgress({ done: completed, total: targets.length });
          }
        };
        await Promise.all(Array.from({ length: workers }, () => scan()));
        if (cancelled) return;
        found.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        setFiles(found);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [book]);

  const accounts = useMemo(() => [...new Set(files.map((f) => f.accountName).filter(Boolean))].sort(), [files]);
  const people = useMemo(() => [...new Set(files.map((f) => f.person).filter(Boolean))].sort(), [files]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return files.filter((f) => {
      if (kind === 'images' && !isImage(f.mime_type)) return false;
      if (kind === 'pdf' && f.mime_type !== 'application/pdf') return false;
      if (source !== 'all' && f.source !== source) return false;
      if (account !== 'all' && f.accountName !== account) return false;
      if (person !== 'all' && f.person !== person) return false;
      if (from && f.relatedDate && f.relatedDate < from) return false;
      if (to && f.relatedDate && f.relatedDate > to) return false;
      if (!q) return true;
      return [f.filename, f.description, f.accountName, f.person, f.status]
        .some((value) => String(value || '').toLowerCase().includes(q));
    });
  }, [files, search, kind, source, account, person, from, to]);

  return (
    <section>
      <div style={heading}>
        <div>
          <h2>Receipts & files</h2>
          <p className="lede" style={{ marginTop: 4 }}>Every stored receipt, photo, quote and PDF attached to a transaction or approval request.</p>
        </div>
        <div style={countBox}>
          <b className="num">{visible.length}</b>
          <span className="muted small">shown · {files.length} stored</span>
        </div>
      </div>

      {loading && (
        <div className="note">
          Finding stored files… {progress.total ? `${progress.done} of ${progress.total} records checked` : 'opening the evidence index'}.
        </div>
      )}
      {error && <div className="note err">Some evidence could not be indexed: {error}</div>}

      <div className="card" style={{ padding: 14, overflow: 'visible' }}>
        <div style={filters}>
          <label style={field}>Search
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filename, reason, account or person" style={control} />
          </label>
          <label style={field}>File type
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={control}>
              <option value="all">All files</option>
              <option value="images">Photos / images</option>
              <option value="pdf">PDFs</option>
            </select>
          </label>
          <label style={field}>Attached to
            <select value={source} onChange={(e) => setSource(e.target.value)} style={control}>
              <option value="all">Transactions + requests</option>
              <option value="entry">Transactions</option>
              <option value="approval">Approval requests</option>
            </select>
          </label>
          <label style={field}>Account
            <select value={account} onChange={(e) => setAccount(e.target.value)} style={control}>
              <option value="all">All accounts</option>
              {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label style={field}>Person
            <select value={person} onChange={(e) => setPerson(e.target.value)} style={control}>
              <option value="all">Everyone</option>
              {people.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label style={field}>From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={control} />
          </label>
          <label style={field}>To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={control} />
          </label>
        </div>
      </div>

      {!loading && !files.length ? (
        <div className="card"><div className="row"><div className="main"><b>No receipts or files stored yet.</b><small>Files added from delegated spending and approval requests will appear here automatically.</small></div></div></div>
      ) : !loading && !visible.length ? (
        <div className="card"><div className="row"><div className="main"><b>No files match these filters.</b><small>Clear a filter or widen the date range.</small></div></div></div>
      ) : (
        <div style={gallery}>
          {visible.map((file) => <FileCard key={file.id} file={file} />)}
        </div>
      )}
    </section>
  );
}

function FileCard({ file }: { file: LibraryItem }) {
  const url = api.evidenceUrl(file.id);
  return (
    <article className="card" style={fileCard}>
      <a href={url} target="_blank" rel="noreferrer" style={previewLink} aria-label={`Open ${file.filename}`}>
        {isImage(file.mime_type)
          ? <img src={url} alt={file.filename} loading="lazy" decoding="async" style={previewImage} />
          : <div style={pdfPreview}><b>PDF</b><span>{size(file.byte_size)}</span></div>}
      </a>
      <div style={details}>
        <div style={fileTitleRow}>
          <b style={fileName}>{file.filename}</b>
          <span className="muted small">{size(file.byte_size)}</span>
        </div>
        <div style={description}>{file.description}</div>
        <div style={metaGrid}>
          <Meta label="Type" value={file.source === 'entry' ? 'Transaction' : 'Approval request'} />
          <Meta label="Amount" value={file.amount == null ? '—' : money(file.amount)} mono />
          <Meta label="Account" value={file.accountName || '—'} />
          <Meta label="Person" value={file.person || '—'} />
          <Meta label="Transaction date" value={file.relatedDate || '—'} />
          <Meta label="Uploaded" value={day(file.created_at) || '—'} />
        </div>
        <div style={cardActions}>
          <span style={pill}>{file.status.replaceAll('_', ' ')}</span>
          <a href={url} target="_blank" rel="noreferrer" className="btn ghost" style={{ textDecoration: 'none' }}>Open file</a>
        </div>
      </div>
    </article>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div style={meta}><span className="muted small">{label}</span><span className={mono ? 'num' : ''} style={{ overflowWrap: 'anywhere' }}>{value}</span></div>;
}

const heading: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 18, alignItems: 'flex-start', marginBottom: 14 };
const countBox: CSSProperties = { display: 'grid', textAlign: 'right', flex: 'none' };
const filters: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(220px,2fr) repeat(auto-fit,minmax(140px,1fr))', gap: 10, alignItems: 'end' };
const field: CSSProperties = { display: 'grid', gap: 5, fontSize: 12, fontWeight: 600, minWidth: 0 };
const control: CSSProperties = { width: '100%', minWidth: 0, minHeight: 40, padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 'var(--r-ctl)', background: 'var(--paper)', color: 'var(--ink)' };
const gallery: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,290px),1fr))', gap: 14 };
const fileCard: CSSProperties = { marginBottom: 0, display: 'flex', flexDirection: 'column', minWidth: 0 };
const previewLink: CSSProperties = { display: 'block', background: 'var(--sunk)', borderBottom: '1px solid var(--line)', minHeight: 190, textDecoration: 'none', color: 'inherit' };
const previewImage: CSSProperties = { width: '100%', height: 210, objectFit: 'contain', display: 'block', background: 'var(--sunk)' };
const pdfPreview: CSSProperties = { height: 210, display: 'grid', placeContent: 'center', justifyItems: 'center', gap: 6, color: 'var(--ink-2)', fontSize: 13 };
const details: CSSProperties = { padding: 14, display: 'grid', gap: 10 };
const fileTitleRow: CSSProperties = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 };
const fileName: CSSProperties = { minWidth: 0, overflowWrap: 'anywhere' };
const description: CSSProperties = { color: 'var(--ink-2)', minHeight: 42, overflowWrap: 'anywhere' };
const metaGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '8px 12px' };
const meta: CSSProperties = { display: 'grid', gap: 1, minWidth: 0, fontSize: 13 };
const cardActions: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 2 };
const pill: CSSProperties = { border: '1px solid var(--line)', background: 'var(--sunk)', borderRadius: 999, padding: '3px 8px', fontSize: 11.5, color: 'var(--ink-2)', textTransform: 'capitalize' };
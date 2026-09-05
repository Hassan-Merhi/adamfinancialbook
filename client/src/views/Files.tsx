import { useEffect, useMemo, useState } from 'react';
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
      setLoading(true); setError(''); setFiles([]);
      try {
        const [dashboard, users] = await Promise.all([api.evidenceDashboard(), api.users()]);
        if (cancelled) return;
        const usernames = new Map(users.users.map((user) => [user.id, user.email]));
        const accountNames = new Map(book.accounts.map((item) => [item.id, item.name]));
        const targets: Target[] = [];

        for (const entry of book.entries) {
          if (entry.voided) continue;
          const accountId = entry.accountId ?? entry.toAccountId ?? null;
          targets.push({
            source: 'entry', id: entry.id, relatedDate: entry.occurredOn,
            description: entry.purpose || entry.raw || 'Book entry', amount: entry.amount,
            accountName: accountId ? accountNames.get(accountId) ?? '' : '',
            person: entry.createdBy ? usernames.get(entry.createdBy) ?? '' : '', status: entry.kind,
          });
        }
        for (const request of dashboard.approvals ?? []) {
          targets.push({
            source: 'approval', id: request.id, relatedDate: day(request.created_at),
            description: request.request_text || 'Approval request', amount: request.amount,
            accountName: request.account_name ?? '', person: request.requester_email ?? '', status: request.status,
          });
        }

        setProgress({ done: 0, total: targets.length });
        if (!targets.length) { setLoading(false); return; }

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
              const response = target.source === 'entry' ? await api.evidenceForEntry(target.id) : await api.evidenceForRequest(target.id);
              for (const file of response.files) found.push({ ...target, ...file, relatedId: target.id });
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
    return files.filter((file) => {
      if (kind === 'images' && !isImage(file.mime_type)) return false;
      if (kind === 'pdf' && file.mime_type !== 'application/pdf') return false;
      if (source !== 'all' && file.source !== source) return false;
      if (account !== 'all' && file.accountName !== account) return false;
      if (person !== 'all' && file.person !== person) return false;
      if (from && file.relatedDate && file.relatedDate < from) return false;
      if (to && file.relatedDate && file.relatedDate > to) return false;
      if (!q) return true;
      return [file.filename, file.description, file.accountName, file.person, file.status].some((value) => String(value || '').toLowerCase().includes(q));
    });
  }, [files, search, kind, source, account, person, from, to]);
  const filtered = !!(search || kind !== 'all' || source !== 'all' || account !== 'all' || person !== 'all' || from || to);
  const clearFilters = () => { setSearch(''); setKind('all'); setSource('all'); setAccount('all'); setPerson('all'); setFrom(''); setTo(''); };

  return (
    <section className="files-page">
      <div className="dhead files-head">
        <div><h2>Receipts & files</h2><p className="muted">Photos, quotes, PDFs, and receipts attached to transactions or approval requests.</p></div>
        <div className="files-count"><b className="num">{visible.length}</b><span>{files.length} stored</span></div>
      </div>

      {loading && <div className="note">Finding stored files… {progress.total ? `${progress.done} of ${progress.total} records checked` : 'opening evidence'}.</div>}
      {error && <div className="note err">Some evidence could not be indexed: {error}</div>}

      <div className="card files-filter-card">
        <div className="files-filters">
          <label className="files-search">Search<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filename, reason, account or user" /></label>
          <label>File type<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">All files</option><option value="images">Photos / images</option><option value="pdf">PDFs</option></select></label>
          <label>Attached to<select value={source} onChange={(e) => setSource(e.target.value)}><option value="all">Transactions + requests</option><option value="entry">Transactions</option><option value="approval">Approval requests</option></select></label>
          <label>Account<select value={account} onChange={(e) => setAccount(e.target.value)}><option value="all">All accounts</option>{accounts.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label>User<select value={person} onChange={(e) => setPerson(e.target.value)}><option value="all">Everyone</option>{people.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          {filtered && <button className="btn ghost small files-clear" onClick={clearFilters}>Clear filters</button>}
        </div>
      </div>

      {!loading && !files.length ? <EmptyState title="No files stored yet" detail="Receipts and files added to transactions or approvals will appear here." />
        : !loading && !visible.length ? <EmptyState title="No files match" detail="Clear a filter or widen the date range." />
        : <div className="files-gallery">{visible.map((file) => <FileCard key={file.id} file={file} />)}</div>}
    </section>
  );
}

function FileCard({ file }: { file: LibraryItem }) {
  const url = api.evidenceUrl(file.id);
  return (
    <article className="card file-card">
      <a href={url} target="_blank" rel="noreferrer" className="file-preview" aria-label={`Open ${file.filename}`}>
        {isImage(file.mime_type) ? <img src={url} alt={file.filename} loading="lazy" decoding="async" /> : <div className="pdf-preview"><b>PDF</b><span>{size(file.byte_size)}</span></div>}
      </a>
      <div className="file-details">
        <div className="file-title"><b>{file.filename}</b><span>{size(file.byte_size)}</span></div>
        <p>{file.description}</p>
        <div className="file-meta">
          <Meta label="Type" value={file.source === 'entry' ? 'Transaction' : 'Approval'} />
          <Meta label="Amount" value={file.amount == null ? '—' : money(file.amount)} mono />
          <Meta label="Account" value={file.accountName || '—'} />
          <Meta label="User" value={file.person || '—'} />
          <Meta label="Date" value={file.relatedDate || '—'} />
          <Meta label="Uploaded" value={day(file.created_at) || '—'} />
        </div>
        <div className="file-actions"><span className="chip">{file.status.replaceAll('_', ' ')}</span><a href={url} target="_blank" rel="noreferrer" className="btn ghost small">Open file</a></div>
      </div>
    </article>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="file-meta-item"><span>{label}</span><b className={mono ? 'num' : ''}>{value}</b></div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="card files-empty"><b>{title}</b><span>{detail}</span></div>;
}

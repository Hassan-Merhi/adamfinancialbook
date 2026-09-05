import { useEffect, useRef, useState } from 'react';
import { api, type Keyholder, type LibraryFile, type LoadedBook } from '../api';

const money = (n: number) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const size = (n: number) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const day = (s: string) => s ? String(s).slice(0, 10) : '';
const isImage = (mime: string) => mime.startsWith('image/');

export default function Files({ book }: { book: LoadedBook }) {
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [users, setUsers] = useState<Keyholder[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [source, setSource] = useState('all');
  const [account, setAccount] = useState('all');
  const [person, setPerson] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const request = useRef(0);

  useEffect(() => {
    let cancelled = false;
    api.users()
      .then((response) => { if (!cancelled) setUsers(response.users); })
      .catch((err) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const serial = ++request.current;
    setLoading(true);
    setError('');
    const timer = window.setTimeout(() => {
      api.filePage({
        q: search,
        kind: kind === 'images' || kind === 'pdf' ? kind : '',
        source: source === 'entry' || source === 'approval' ? source : '',
        accountId: account === 'all' ? '' : account,
        userId: person === 'all' ? '' : person,
        from,
        to,
        limit: 40,
      })
        .then((page) => {
          if (serial !== request.current) return;
          setFiles(page.items);
          setNextCursor(page.nextCursor);
        })
        .catch((err) => {
          if (serial === request.current) setError((err as Error).message);
        })
        .finally(() => {
          if (serial === request.current) setLoading(false);
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search, kind, source, account, person, from, to]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const page = await api.filePage({
        q: search,
        kind: kind === 'images' || kind === 'pdf' ? kind : '',
        source: source === 'entry' || source === 'approval' ? source : '',
        accountId: account === 'all' ? '' : account,
        userId: person === 'all' ? '' : person,
        from,
        to,
        cursor: nextCursor,
        limit: 40,
      });
      setFiles((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const filtered = !!(search || kind !== 'all' || source !== 'all' || account !== 'all' || person !== 'all' || from || to);
  const clearFilters = () => {
    setSearch('');
    setKind('all');
    setSource('all');
    setAccount('all');
    setPerson('all');
    setFrom('');
    setTo('');
  };

  return (
    <section className="files-page">
      <div className="dhead files-head">
        <div><h2>Receipts & files</h2><p className="muted">Photos, quotes, PDFs, and receipts attached to transactions or approval requests.</p></div>
        <div className="files-count"><b className="num">{files.length}</b><span>{nextCursor ? 'loaded · more available' : 'loaded'}</span></div>
      </div>

      {loading && <div className="note">Finding stored files…</div>}
      {error && <div className="note err">Could not load some evidence: {error}</div>}

      <div className="card files-filter-card">
        <div className="files-filters">
          <label className="files-search">Search<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filename, reason, account or user" /></label>
          <label>File type<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">All files</option><option value="images">Photos / images</option><option value="pdf">PDFs</option></select></label>
          <label>Attached to<select value={source} onChange={(e) => setSource(e.target.value)}><option value="all">Transactions + requests</option><option value="entry">Transactions</option><option value="approval">Approval requests</option></select></label>
          <label>Account<select value={account} onChange={(e) => setAccount(e.target.value)}><option value="all">All accounts</option>{book.accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>User<select value={person} onChange={(e) => setPerson(e.target.value)}><option value="all">Everyone</option>{users.map((item) => <option key={item.id} value={item.id}>{item.email}</option>)}</select></label>
          <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          {filtered && <button className="btn ghost small files-clear" onClick={clearFilters}>Clear filters</button>}
        </div>
      </div>

      {!loading && !files.length
        ? <EmptyState title={filtered ? 'No files match' : 'No files stored yet'} detail={filtered ? 'Clear a filter or widen the date range.' : 'Receipts and files added to transactions or approvals will appear here.'} />
        : <div className="files-gallery">{files.map((file) => <FileCard key={file.id} file={file} />)}</div>}

      {nextCursor && (
        <div className="files-load-more">
          <button className="btn ghost" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading…' : 'Load more files'}
          </button>
        </div>
      )}
    </section>
  );
}

function FileCard({ file }: { file: LibraryFile }) {
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

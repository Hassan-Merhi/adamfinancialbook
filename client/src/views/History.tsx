/** What has been done to the book, plus export and backup actions. */
import { useEffect, useState } from 'react';
import { api, type LoadedBook } from '../api';
import type { AuditLine } from '../../../shared/types';
import { Card, Empty, money, shortDate } from '../ui';

export default function History({ book }: { book: LoadedBook }) {
  const [lines, setLines] = useState<AuditLine[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const voided = book.entries.filter((e) => e.voided);

  useEffect(() => {
    let cancelled = false;
    api.historyPage(null, 50)
      .then((page) => {
        if (cancelled) return;
        setLines(page.lines);
        setNextCursor(page.nextCursor);
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.historyPage(nextCursor, 50);
      setLines((current) => [...current, ...page.lines]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section className="history-page">
      <div className="dhead history-head">
        <div><h2>History</h2><p className="muted">Audit trail, voided entries, exports, and backups.</p></div>
        {!loading && <span className="chip">{lines.length} loaded events</span>}
      </div>

      <div className="history-export-grid">
        <a className="history-export-card" href="/api/export/entries.csv"><span>Spreadsheet</span><b>Export entries</b><small>CSV for Excel or Sheets</small></a>
        <a className="history-export-card" href="/api/backup.json"><span>Backup</span><b>Download whole book</b><small>Complete JSON snapshot</small></a>
      </div>

      {voided.length > 0 && (
        <Card title="Recent voided entries" aside={`${voided.length} · not counting`}>
          {voided.map((entry) => (
            <div className="row history-void-row" key={entry.id}>
              <span className="main"><b>{entry.purpose}</b><small>{shortDate(entry.occurredOn)} · {entry.voidReason}</small></span>
              <span className="val num muted">{money(entry.amount)}</span>
            </div>
          ))}
        </Card>
      )}

      <Card title="Audit trail" aside={lines.length ? 'newest first' : undefined}>
        {error && <Empty>{error}</Empty>}
        {loading && !error && <Empty>Reading the history…</Empty>}
        {!loading && !error && lines.length === 0 && <Empty>Nothing has been done to this book yet.</Empty>}
        <div className="audit-timeline">
          {lines.map((line) => (
            <article className="audit-event" key={line.id}>
              <span className="audit-dot" aria-hidden="true" />
              <div className="audit-copy"><b>{line.action}</b>{describe(line) && <small>{describe(line)}</small>}<span>{line.actorEmail ?? 'someone'}</span></div>
              <time>{new Date(line.at).toLocaleString()}</time>
            </article>
          ))}
        </div>
        {nextCursor && (
          <button className="btn ghost" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading…' : 'Load older history'}
          </button>
        )}
      </Card>
    </section>
  );
}

function describe(line: AuditLine): string {
  const d = line.detail as Record<string, string | number | undefined>;
  const bits: string[] = [];
  if (d.name) bits.push(String(d.name));
  if (d.purpose) bits.push(String(d.purpose));
  if (d.amount != null) bits.push(money(Number(d.amount)));
  if (d.from != null && d.to != null) bits.push(`${money(Number(d.from))} → ${money(Number(d.to))}`);
  if (d.reason) bits.push(`“${d.reason}”`);
  if (d.opening) bits.push(`opening ${money(Number(d.opening))}`);
  if (d.salary) bits.push(`salary ${money(Number(d.salary))}`);
  return bits.join(' · ');
}

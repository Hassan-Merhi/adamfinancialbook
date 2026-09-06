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
  const voided = book.entries.filter((entry) => entry.voided);

  useEffect(() => {
    let cancelled = false;
    api.historyPage(null, 50)
      .then((page) => {
        if (cancelled) return;
        setLines(page.lines);
        setNextCursor(page.nextCursor);
      })
      .catch((error) => { if (!cancelled) setError((error as Error).message); })
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
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const auditTrail = (
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
        <button className="btn ghost history-load-more" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? 'Loading…' : 'Load older history'}
        </button>
      )}
    </Card>
  );

  return (
    <section className="history-page">
      <div className="dhead history-head">
        <div><h2>History</h2><p className="muted">Audit trail, voided entries, exports, and backups.</p></div>
        {!loading && <span className="chip">{lines.length} loaded events</span>}
      </div>

      <div className="history-desktop-tools">
        <HistoryExports />
        {voided.length > 0 && (
          <Card title="Recent voided entries" aside={`${voided.length} · not counting`}>
            <VoidedRows entries={voided} />
          </Card>
        )}
      </div>

      {auditTrail}

      <div className="history-mobile-tools">
        <details className="history-tool-disclosure">
          <summary><span>Exports & backup</span><small>CSV + JSON</small></summary>
          <div className="history-tool-body"><HistoryExports /></div>
        </details>

        {voided.length > 0 && (
          <details className="history-tool-disclosure">
            <summary><span>Voided entries</span><small className="num">{voided.length}</small></summary>
            <div className="history-tool-body history-voided-mobile"><VoidedRows entries={voided} /></div>
          </details>
        )}
      </div>
    </section>
  );
}

function HistoryExports() {
  return (
    <div className="history-export-grid">
      <a className="history-export-card" href="/api/export/entries.csv"><span>Spreadsheet</span><b>Export entries</b><small>CSV for Excel or Sheets</small></a>
      <a className="history-export-card" href="/api/backup.json"><span>Backup</span><b>Download whole book</b><small>Complete JSON snapshot</small></a>
    </div>
  );
}

function VoidedRows({ entries }: { entries: LoadedBook['entries'] }) {
  return (
    <>
      {entries.map((entry) => (
        <div className="row history-void-row" key={entry.id}>
          <span className="main"><b>{entry.purpose}</b><small>{shortDate(entry.occurredOn)} · {entry.voidReason}</small></span>
          <span className="val num muted">{money(entry.amount)}</span>
        </div>
      ))}
    </>
  );
}

function describe(line: AuditLine): string {
  const detail = line.detail as Record<string, string | number | undefined>;
  const bits: string[] = [];
  if (detail.name) bits.push(String(detail.name));
  if (detail.purpose) bits.push(String(detail.purpose));
  if (detail.amount != null) bits.push(money(Number(detail.amount)));
  if (detail.from != null && detail.to != null) bits.push(`${money(Number(detail.from))} → ${money(Number(detail.to))}`);
  if (detail.reason) bits.push(`“${detail.reason}”`);
  if (detail.opening) bits.push(`opening ${money(Number(detail.opening))}`);
  if (detail.salary) bits.push(`salary ${money(Number(detail.salary))}`);
  return bits.join(' · ');
}

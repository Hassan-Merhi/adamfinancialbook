/**
 * What has been done to the book, and the ways of getting it out.
 *
 * Nothing here changes a figure — it is the record beside the record.
 */
import { useEffect, useState } from 'react';
import { api, type LoadedBook } from '../api';
import type { AuditLine } from '../../../shared/types';
import { Card, Empty, money, shortDate } from '../ui';

export default function History({ book }: { book: LoadedBook }) {
  const [lines, setLines] = useState<AuditLine[] | null>(null);
  const [error, setError] = useState('');
  const voided = book.entries.filter((e) => e.voided);

  useEffect(() => {
    api.history().then((r) => setLines(r.lines)).catch((e) => setError((e as Error).message));
  }, []);

  return (
    <>
      <p className="lede">
        Every change to the book, oldest at the bottom. An entry is never deleted — a wrong one is
        voided, stops counting, and stays here with its reason.
      </p>

      <Card title="Take it with you">
        <div className="form">
          <a className="btn ghost" href="/api/export/entries.csv">Entries as a spreadsheet</a>
          <a className="btn ghost" href="/api/backup.json">Whole book, as a backup</a>
        </div>
      </Card>

      {voided.length > 0 && (
        <Card title="Voided" aside={`${voided.length} — counting for nothing`}>
          {voided.map((e) => (
            <div className="row" key={e.id}>
              <span className="main">
                <b style={{ textDecoration: 'line-through' }}>{e.purpose}</b>
                <small>{shortDate(e.occurredOn)} · {e.voidReason}</small>
              </span>
              <span className="val num muted">{money(e.amount)}</span>
            </div>
          ))}
        </Card>
      )}

      <Card title="History" aside={lines ? `${lines.length} lines` : undefined}>
        {error && <Empty>{error}</Empty>}
        {!lines && !error && <Empty>Reading the history…</Empty>}
        {lines?.length === 0 && <Empty>Nothing has been done to this book yet.</Empty>}
        {lines?.map((l) => (
          <div className="row" key={l.id}>
            <span className="main">
              <b>{l.action}</b>
              <small>{describe(l)}</small>
            </span>
            <span className="val num muted" style={{ fontWeight: 400, fontSize: 12.5 }}>
              {new Date(l.at).toLocaleString()}
              <small>{l.actorEmail ?? 'someone'}</small>
            </span>
          </div>
        ))}
      </Card>
    </>
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

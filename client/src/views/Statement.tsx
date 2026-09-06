/** Paginated target statement with server-side filtering and projected offline rows. */
import { useEffect, useRef, useState } from 'react';
import { api, type LoadedBook, type StatementRowView, type StatementTarget } from '../api';
import { isProjectedEntry } from '../offline-projection';
import { deltaFor } from '../../../shared/engine';
import type { Entry } from '../../../shared/types';
import { Card, Empty, KINDS, money, shortDate, signed, tone } from '../ui';

export type Focus = StatementTarget;

export default function Statement({ book, focus, back, run }: {
  book: LoadedBook;
  focus: Focus;
  back: () => void;
  run: (work: () => Promise<unknown>, done: string) => void;
}) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<StatementRowView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [summary, setSummary] = useState({ total: 0, inSum: 0, outSum: 0 });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);

  const filters = { q, kind, from, to };

  useEffect(() => {
    const serial = ++request.current;
    setLoading(true);
    setError('');
    const timer = window.setTimeout(() => {
      api.statementPage(focus, { ...filters, limit: 50 })
        .then((page) => {
          if (serial !== request.current) return;
          setRows(page.items);
          setNextCursor(page.nextCursor);
          setSummary({ total: page.total, inSum: page.inSum, outSum: page.outSum });
        })
        .catch((err) => {
          if (serial === request.current) setError((err as Error).message);
        })
        .finally(() => {
          if (serial === request.current) setLoading(false);
        });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [book, focus, q, kind, from, to]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.statementPage(focus, { ...filters, cursor: nextCursor, limit: 50 });
      setRows((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const person = focus.type === 'person' ? book.people.find((candidate) => candidate.id === focus.id) : undefined;
  const pendingForTarget = book.entries
    .filter(isProjectedEntry)
    .map((entry) => ({ entry, delta: deltaFor(entry, focus, person) }))
    .filter((row) => row.delta !== 0);
  const pendingRows = pendingForTarget.filter(({ entry }) => matchesFilters(entry, filters));

  const head = describe(book, focus);
  const filtered = !!(q || kind || from || to);

  return (
    <>
      <button className="back" onClick={back}>← {head.backLabel}</button>

      <div className="dhead">
        <div>
          <h2>{head.title}</h2>
          <p className="muted">{head.sub}</p>
        </div>
        <div className="bal">
          <small>{head.balanceLabel}{pendingForTarget.length ? ' · projected' : ''}</small>
          <span className={`num ${head.signed ? tone(head.balance) : ''}`}>{money(head.balance)}</span>
        </div>
      </div>

      <div className="filters">
        <input className="fi grow" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search purpose or description" />
        <select className="fi" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All types</option>
          {Object.entries(KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <label className="flab">From <input className="fi" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="flab">To <input className="fi" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {filtered && (
          <button className="btn ghost small" onClick={() => { setQ(''); setKind(''); setFrom(''); setTo(''); }}>Clear</button>
        )}
      </div>

      {pendingForTarget.length > 0 && (
        <Card title="Pending sync" aside={`${pendingForTarget.length} projected`}>
          {pendingRows.length === 0
            ? <Empty>No pending entries match these filters.</Empty>
            : pendingRows.map(({ entry, delta }) => (
                <div className="row" key={entry.id}>
                  <span className="main">
                    <b>{entry.purpose}</b>
                    <small>{shortDate(entry.occurredOn)} · {KINDS[entry.kind]} · not server-confirmed yet</small>
                  </span>
                  <span className={`val num ${tone(delta)}`}>{delta ? signed(delta) : '—'}</span>
                </div>
              ))}
        </Card>
      )}

      <Card
        title="Statement"
        aside={!loading ? `${summary.total} server-confirmed matching · in ${money(summary.inSum)} · out ${money(Math.abs(summary.outSum))}` : undefined}
      >
        {error && <Empty>{pendingForTarget.length ? 'Server-confirmed statement is unavailable right now. Pending projected entries are shown above.' : error}</Empty>}
        {loading && !error && <Empty>Reading the statement…</Empty>}
        {!loading && !error && rows.length === 0 && <Empty>Nothing matches these filters.</Empty>}
        {rows.length > 0 && (
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th><th>Entry</th><th>Type</th>
                  <th className="r">In / out</th>
                  <th className="r">{focus.type === 'project' ? 'Net' : 'Balance'}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.entry.id}>
                    <td className="num small">{shortDate(r.entry.occurredOn)}</td>
                    <td>
                      <b>{r.entry.purpose}</b>
                      <small>{alsoChanged(book, r.entry, focus)}</small>
                      {r.entry.correctedFrom != null && (
                        <small className="flag">corrected · was {money(r.entry.correctedFrom)}</small>
                      )}
                      {r.entry.historical && <small className="flag">historical</small>}
                    </td>
                    <td className="small muted">{KINDS[r.entry.kind]}</td>
                    <td className={`r num ${tone(r.delta)}`}>{r.delta ? signed(r.delta) : '—'}</td>
                    <td className="r num">{money(r.running)}</td>
                    <td className="r nowrap">
                      <button className="btn ghost small" onClick={() => {
                        const next = prompt(`Correct the amount for "${r.entry.purpose}"`, String(r.entry.amount));
                        const amount = Number(next);
                        if (next && amount > 0 && amount !== r.entry.amount) {
                          run(() => api.correct(r.entry.id, amount), 'Corrected.');
                        }
                      }}>Correct</button>
                      <button className="btn ghost small" onClick={() => {
                        const reason = prompt(`Void "${r.entry.purpose}"? It will stop counting but stay on the record.\n\nWhy:`);
                        if (reason?.trim()) run(() => api.voidEntry(r.entry.id, reason.trim()), 'Voided — it counts for nothing now.');
                      }}>Void</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextCursor && (
          <div className="center"><button className="btn ghost" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading…' : 'Load older entries'}
          </button></div>
        )}
      </Card>

      {focus.type === 'project' && (
        <Card title="Recorded before the cut-off">
          {book.receipts.filter((r) => r.projectId === focus.id && !r.entryId).length === 0
            ? <Empty>Nothing — every receipt on this project was entered here.</Empty>
            : book.receipts.filter((r) => r.projectId === focus.id && !r.entryId).map((r) => (
                <div className="row" key={r.id}>
                  <span className="main"><b>{shortDate(r.occurredOn)}</b>
                    <small>{r.inCash ? 'received in cash' : 'not in cash yet'}</small></span>
                  <span className="val num">{money(r.amount)}</span>
                </div>
              ))}
        </Card>
      )}
    </>
  );
}

function matchesFilters(entry: Entry, filters: { q: string; kind: string; from: string; to: string }): boolean {
  if (filters.kind && entry.kind !== filters.kind) return false;
  if (filters.from && entry.occurredOn < filters.from) return false;
  if (filters.to && entry.occurredOn > filters.to) return false;
  if (filters.q.trim()) {
    const needle = filters.q.trim().toLowerCase();
    const haystack = `${entry.purpose} ${entry.raw}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function describe(book: LoadedBook, focus: Focus) {
  if (focus.type === 'account') {
    const a = book.accounts.find((x) => x.id === focus.id)!;
    const business = book.businesses.find((b) => b.id === a.businessId)?.name;
    return { title: a.name, sub: `${business} · cash account`, balanceLabel: 'Balance now',
      balance: book.balances.accounts[a.id] ?? 0, signed: false, backLabel: 'Accounts & loans' };
  }
  if (focus.type === 'person') {
    const p = book.people.find((x) => x.id === focus.id)!;
    const balance = book.balances.people[p.id] ?? 0;
    return {
      title: p.name,
      sub: `${p.role} · ${p.kind === 'receivable' ? 'plus means they owe you' : 'minus means you owe them'}`,
      balanceLabel: balance < 0 ? 'You owe' : 'Owed to you',
      balance, signed: true, backLabel: 'People',
    };
  }
  if (focus.type === 'project') {
    const p = book.projects.find((x) => x.id === focus.id)!;
    return { title: p.name, sub: `${p.scope} · receipts count up, money spent on the job counts down`,
      balanceLabel: 'Total received', balance: book.balances.projects[p.id] ?? 0, signed: false, backLabel: 'Projects' };
  }
  const loan = book.loans.find((l) =>
    (l.fromBusiness === focus.fromBusiness && l.toBusiness === focus.toBusiness) ||
    (l.fromBusiness === focus.toBusiness && l.toBusiness === focus.fromBusiness))!;
  const raw = book.balances.loans[loan.id] ?? 0;
  const balance = loan.fromBusiness === focus.view ? -raw : raw;
  const mine = book.businesses.find((b) => b.id === focus.view)?.name;
  const other = book.businesses.find((b) => b.id === (focus.view === loan.fromBusiness ? loan.toBusiness : loan.fromBusiness))?.name;
  return {
    title: `${mine} ↔ ${other}`,
    sub: `Between your own businesses · seen from ${mine}'s side`,
    balanceLabel: balance < 0 ? `${mine} owes` : `${mine} is owed`,
    balance, signed: true, backLabel: 'Accounts & loans',
  };
}

function alsoChanged(book: LoadedBook, entry: Entry, focus: Focus): string {
  const bits: string[] = [];
  for (const e of entry.effects) {
    if (e.type === 'account' && !(focus.type === 'account' && e.targetId === focus.id)) {
      bits.push(book.accounts.find((a) => a.id === e.targetId)?.name ?? '');
    }
    if (e.type === 'person' && !(focus.type === 'person' && e.targetId === focus.id)) {
      const p = book.people.find((x) => x.id === e.targetId);
      if (p) bits.push(`${p.name} ${p.kind === 'payable' ? 'payable' : p.kind === 'salary' ? 'salary' : 'owes you'}`);
    }
    if (e.type === 'loan') {
      const from = book.businesses.find((b) => b.id === e.fromBusiness)?.name;
      const to = book.businesses.find((b) => b.id === e.toBusiness)?.name;
      bits.push(`${e.delta < 0 ? 'paid down' : 'increased'} ${from} → ${to}`);
    }
    if (e.type === 'cost' && !(focus.type === 'project' && e.targetId === focus.id)) {
      bits.push(`${book.projects.find((p) => p.id === e.targetId)?.name} — spent on the job`);
    }
    if (e.type === 'receipt_banked') bits.push('an earlier receipt reaching cash, not new money');
  }
  return bits.filter(Boolean).join(' · ');
}

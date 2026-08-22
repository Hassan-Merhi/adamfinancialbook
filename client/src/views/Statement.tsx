/**
 * Everything that touched one thing, with a running balance and the filters to
 * find your way back to a single entry.
 */
import { useMemo, useState } from 'react';
import { api, type LoadedBook } from '../api';
import { deltaFor, ordered, statement } from '../../../shared/engine';
import type { Entry } from '../../../shared/types';
import { Card, Empty, KINDS, money, shortDate, signed, tone } from '../ui';

export type Focus =
  | { type: 'account'; id: string }
  | { type: 'person'; id: string }
  | { type: 'project'; id: string }
  | { type: 'loan'; fromBusiness: string; toBusiness: string; view: string };

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

  const head = describe(book, focus);
  const rows = useMemo(() => statement(book, focus), [book, focus]);

  const matches = (e: Entry) => {
    if (kind && e.kind !== kind) return false;
    if (from && e.occurredOn < from) return false;
    if (to && e.occurredOn > to) return false;
    if (q) {
      const person = book.people.find((p) => p.id === e.personId)?.name ?? '';
      const project = book.projects.find((p) => p.id === e.projectId)?.name ?? '';
      if (!`${e.purpose} ${e.raw} ${person} ${project}`.toLowerCase().includes(q.toLowerCase())) return false;
    }
    return true;
  };

  const shown = rows.filter((r) => matches(r.entry)).reverse();
  const inSum = shown.filter((r) => r.delta > 0).reduce((s, r) => s + r.delta, 0);
  const outSum = shown.filter((r) => r.delta < 0).reduce((s, r) => s + r.delta, 0);
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
          <small>{head.balanceLabel}</small>
          <span className={`num ${head.signed ? tone(head.balance) : ''}`}>{money(head.balance)}</span>
        </div>
      </div>

      <div className="filters">
        <input className="fi grow" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search purpose, person, project" />
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

      <Card
        title="Statement"
        aside={`${shown.length} of ${rows.length} · in ${money(inSum)} · out ${money(Math.abs(outSum))}`}
      >
        {shown.length === 0 ? <Empty>Nothing matches these filters.</Empty> : (
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
                {shown.map((r) => (
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

/* ------------------------------------------------------------------ */

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

/** What else this entry moved, other than the thing you are looking at. */
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

export { deltaFor, ordered };

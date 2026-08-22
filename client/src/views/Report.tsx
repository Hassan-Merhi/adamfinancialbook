/**
 * The whole day on one screen, and any past day rebuilt exactly as it stood —
 * balances are opening figures plus effects, so a date is all it takes.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { api, type LoadedBook } from '../api';
import {
  accountBalance, businessCash, loanBalance, ordered, personBalance, totalCash,
} from '../../../shared/engine';
import type { Entry } from '../../../shared/types';
import { Card, Empty, longDate, money, shiftDay, shortDate, signed, today, tone } from '../ui';

export default function Report({ book, run }: {
  book: LoadedBook;
  run: (work: () => Promise<unknown>, done: string) => void;
}) {
  const [date, setDate] = useState(today());
  const [business, setBusiness] = useState('');
  const isToday = date === today();

  const businessOf = (e: Entry) => {
    if (e.accountId) return book.accounts.find((a) => a.id === e.accountId)?.businessId;
    if (e.personId) return book.people.find((p) => p.id === e.personId)?.businessId;
    return undefined;
  };

  const day = useMemo(
    // ordered() leaves out voided entries: they count for nothing, here too
    () => ordered(book.entries).filter((e) => e.occurredOn === date && (!business || businessOf(e) === business)),
    [book.entries, date, business],
  );

  const received = day.filter((e) => e.kind === 'receipt' && !e.historical);
  const spent = day.filter((e) => !e.historical && ['expense', 'salary', 'person_loan', 'supplier_payment'].includes(e.kind));
  const credit = day.filter((e) => e.kind === 'credit_purchase');
  const moved = day.filter((e) => e.kind === 'transfer');
  const businesses = business ? book.businesses.filter((b) => b.id === business) : book.businesses;

  const cashOf = (id: string) => businessCash(book, id, date);
  const total = business ? cashOf(business) : totalCash(book, date);

  return (
    <>
      <div className="daynav">
        <button className="arw" onClick={() => setDate(shiftDay(date, -1))} aria-label="Previous day">‹</button>
        <div className="d">
          <b>{longDate(date)}</b>
          <small>{isToday ? 'today' : 'a day already closed'}</small>
        </div>
        <button className="arw" onClick={() => setDate(shiftDay(date, 1))} disabled={isToday} aria-label="Next day">›</button>
        <input className="fi" type="date" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        {!isToday && <button className="btn ghost small" onClick={() => setDate(today())}>Today</button>}
        <select className="fi" value={business} onChange={(e) => setBusiness(e.target.value)}>
          <option value="">All businesses</option>
          {book.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      <Card title={`Cash at end of ${shortDate(date)}`}>
        {businesses.map((b) => (
          <div className="row" key={b.id}>
            <span className="main"><b>{b.name}</b>
              <small>{book.accounts.filter((a) => a.businessId === b.id)
                .map((a) => `${a.name} ${money(accountBalance(book, a.id, date))}`).join(' · ') || 'no accounts'}</small>
            </span>
            <span className="val num">{money(cashOf(b.id))}</span>
          </div>
        ))}
        <div className="row total"><span className="main"><b>Total</b></span>
          <span className="val num">{money(total)}</span></div>
      </Card>

      <Card title="Received">
        {received.length === 0 ? <Empty>Nothing received this day.</Empty> : received.map((e) => (
          <div className="row" key={e.id}>
            <span className="main"><b>{book.projects.find((p) => p.id === e.projectId)?.name ?? e.purpose}</b>
              <small>{book.accounts.find((a) => a.id === e.accountId)?.name}</small></span>
            <span className="val num pos">{signed(e.amount)}</span>
          </div>
        ))}
      </Card>

      <Card title="Spent">
        {spent.length === 0 ? <Empty>Nothing spent this day.</Empty> : spent.map((e) => (
          <div className="row" key={e.id}>
            <span className="main"><b>{e.purpose}</b>
              <small>{book.accounts.find((a) => a.id === e.accountId)?.name}</small></span>
            <span className="val num neg">{signed(-e.amount)}</span>
          </div>
        ))}
      </Card>

      {credit.length > 0 && (
        <Card title="Taken on credit — not paid">
          {credit.map((e) => (
            <div className="row" key={e.id}>
              <span className="main"><b>{e.purpose}</b>
                <small>{book.people.find((p) => p.id === e.personId)?.name}</small></span>
              <span className="val num neg">{money(-e.amount)}</span>
            </div>
          ))}
        </Card>
      )}

      {moved.length > 0 && (
        <Card title="Moved — not spent">
          {moved.map((e) => (
            <div className="row" key={e.id}>
              <span className="main"><b>{book.accounts.find((a) => a.id === e.accountId)?.name}
                {' → '}{book.accounts.find((a) => a.id === e.toAccountId)?.name}</b>
                <small>{e.purpose}</small></span>
              <span className="val num">{money(e.amount)}</span>
            </div>
          ))}
        </Card>
      )}

      <Card title={`Outstanding at end of ${shortDate(date)}`}>
        {(() => {
          const lines: ReactElement[] = [];
          for (const l of book.loans) {
            if (business && l.fromBusiness !== business && l.toBusiness !== business) continue;
            const v = loanBalance(book, l, date);
            if (!v) continue;
            const from = book.businesses.find((b) => b.id === (v >= 0 ? l.fromBusiness : l.toBusiness))?.name;
            const to = book.businesses.find((b) => b.id === (v >= 0 ? l.toBusiness : l.fromBusiness))?.name;
            lines.push(
              <div className="row" key={l.id}>
                <span className="main"><b>{from} → {to}</b><small>between your businesses</small></span>
                <span className="val num">{money(Math.abs(v))}</span>
              </div>);
          }
          for (const p of book.people) {
            if (business && p.businessId !== business) continue;
            const v = personBalance(book, p.id, date);
            if (!v) continue;
            lines.push(
              <div className="row" key={p.id}>
                <span className="main"><b>{p.name}</b><small>{v < 0 ? 'you owe' : 'owes you'}</small></span>
                <span className={`val num ${tone(v)}`}>{money(v)}</span>
              </div>);
          }
          return lines.length ? lines : <Empty>Nothing outstanding.</Empty>;
        })()}
      </Card>

      <Card title="Reminders" aside="promises, not movements">
        {book.reminders.length === 0 ? <Empty>Nothing pending.</Empty> : book.reminders.map((r) => (
          <div className="row" key={r.id}>
            <span className="main"><b>{r.what}</b>
              <small>{[book.accounts.find((a) => a.id === r.accountId)?.name, r.note].filter(Boolean).join(' · ')}</small></span>
            <span className="val num">{money(r.amount)}
              <small>
                <button className="linkbtn" onClick={() => run(() => api.clearReminder(r.id), 'Reminder cleared.')}>clear</button>
              </small>
            </span>
          </div>
        ))}
      </Card>
    </>
  );
}

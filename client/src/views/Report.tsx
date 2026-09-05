/** The whole day on one screen, with past balances rebuilt by SQL on demand. */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { api, type LoadedBook } from '../api';
import { ordered } from '../../../shared/engine';
import type { Entry } from '../../../shared/types';
import { Card, Empty, longDate, money, shiftDay, shortDate, signed, today, tone } from '../ui';

export default function Report({ book, run }: {
  book: LoadedBook;
  run: (work: () => Promise<unknown>, done: string) => void;
}) {
  const [date, setDate] = useState(today());
  const [business, setBusiness] = useState('');
  const [historical, setHistorical] = useState<LoadedBook | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const isToday = date === today();

  useEffect(() => {
    if (isToday) {
      setHistorical(null);
      setLoading(false);
      setError('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    api.overview(date)
      .then((next) => { if (!cancelled) setHistorical(next); })
      .catch((err) => { if (!cancelled) setError((err as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date, isToday]);

  const activeBook = isToday ? book : historical ?? book;
  const businessOf = (e: Entry) => {
    if (e.accountId) return activeBook.accounts.find((a) => a.id === e.accountId)?.businessId;
    if (e.personId) return activeBook.people.find((p) => p.id === e.personId)?.businessId;
    return undefined;
  };

  const day = useMemo(
    () => ordered(activeBook.entries).filter((e) => e.occurredOn === date && (!business || businessOf(e) === business)),
    [activeBook, date, business],
  );

  const received = day.filter((e) => e.kind === 'receipt' && !e.historical);
  const spent = day.filter((e) => !e.historical && ['expense', 'salary', 'person_loan', 'supplier_payment'].includes(e.kind));
  const credit = day.filter((e) => e.kind === 'credit_purchase');
  const moved = day.filter((e) => e.kind === 'transfer');
  const businesses = business ? activeBook.businesses.filter((b) => b.id === business) : activeBook.businesses;
  const receivedTotal = received.reduce((sum, entry) => sum + entry.amount, 0);
  const spentTotal = spent.reduce((sum, entry) => sum + entry.amount, 0);
  const netActivity = receivedTotal - spentTotal;
  const cashOf = (id: string) => activeBook.balances.businesses[id] ?? 0;
  const total = business ? cashOf(business) : activeBook.balances.totalCash;

  return (
    <section className="report-page">
      <div className="dhead report-head">
        <div><h2>Day report</h2><p className="muted">A clean daily view of cash, money in, money out, and what is still outstanding.</p></div>
        <span className="chip">{loading ? 'Loading…' : `${day.length} entr${day.length === 1 ? 'y' : 'ies'}`}</span>
      </div>

      <div className="daynav report-daynav">
        <button className="arw" onClick={() => setDate(shiftDay(date, -1))} aria-label="Previous day">‹</button>
        <div className="d"><b>{longDate(date)}</b><small>{isToday ? 'today' : 'closed day'}</small></div>
        <button className="arw" onClick={() => setDate(shiftDay(date, 1))} disabled={isToday} aria-label="Next day">›</button>
        <input className="fi" type="date" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        {!isToday && <button className="btn ghost small" onClick={() => setDate(today())}>Today</button>}
        <select className="fi" value={business} onChange={(e) => setBusiness(e.target.value)}><option value="">All businesses</option>{book.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      </div>

      {error && <Card title="Could not load this day"><Empty>{error}</Empty></Card>}

      <div className="report-summary" aria-label="Day totals">
        <ReportStat label="Cash at close" value={money(total)} strong />
        <ReportStat label="Money in" value={money(receivedTotal)} tone={receivedTotal ? 'pos' : ''} />
        <ReportStat label="Money out" value={money(spentTotal)} tone={spentTotal ? 'neg' : ''} />
        <ReportStat label="Net activity" value={signed(netActivity)} tone={tone(netActivity)} />
      </div>

      <Card title={`Cash at end of ${shortDate(date)}`} aside={`${businesses.length} business${businesses.length === 1 ? '' : 'es'}`}>
        {businesses.map((b) => (
          <div className="row" key={b.id}>
            <span className="main"><b>{b.name}</b><small>{activeBook.accounts.filter((a) => a.businessId === b.id).map((a) => `${a.name} ${money(activeBook.balances.accounts[a.id] ?? 0)}`).join(' · ') || 'no accounts'}</small></span>
            <span className="val num">{money(cashOf(b.id))}</span>
          </div>
        ))}
      </Card>

      <div className="report-flow-grid">
        <Card title="Received" aside={received.length ? money(receivedTotal) : undefined}>
          {received.length === 0 ? <Empty>Nothing received this day.</Empty> : received.map((e) => (
            <div className="row" key={e.id}><span className="main"><b>{activeBook.projects.find((p) => p.id === e.projectId)?.name ?? e.purpose}</b><small>{activeBook.accounts.find((a) => a.id === e.accountId)?.name}</small></span><span className="val num pos">{signed(e.amount)}</span></div>
          ))}
        </Card>
        <Card title="Spent" aside={spent.length ? money(spentTotal) : undefined}>
          {spent.length === 0 ? <Empty>Nothing spent this day.</Empty> : spent.map((e) => (
            <div className="row" key={e.id}><span className="main"><b>{e.purpose}</b><small>{activeBook.accounts.find((a) => a.id === e.accountId)?.name}</small></span><span className="val num neg">{signed(-e.amount)}</span></div>
          ))}
        </Card>
      </div>

      {credit.length > 0 && <Card title="Taken on credit" aside="not paid yet">{credit.map((e) => <div className="row" key={e.id}><span className="main"><b>{e.purpose}</b><small>{activeBook.people.find((p) => p.id === e.personId)?.name}</small></span><span className="val num neg">{money(-e.amount)}</span></div>)}</Card>}
      {moved.length > 0 && <Card title="Moved between accounts" aside="not spending">{moved.map((e) => <div className="row" key={e.id}><span className="main"><b>{activeBook.accounts.find((a) => a.id === e.accountId)?.name} → {activeBook.accounts.find((a) => a.id === e.toAccountId)?.name}</b><small>{e.purpose}</small></span><span className="val num">{money(e.amount)}</span></div>)}</Card>}

      <Card title={`Outstanding at end of ${shortDate(date)}`}>
        {(() => {
          const lines: ReactElement[] = [];
          for (const l of activeBook.loans) {
            if (business && l.fromBusiness !== business && l.toBusiness !== business) continue;
            const v = activeBook.balances.loans[l.id] ?? 0;
            if (!v) continue;
            const from = activeBook.businesses.find((b) => b.id === (v >= 0 ? l.fromBusiness : l.toBusiness))?.name;
            const to = activeBook.businesses.find((b) => b.id === (v >= 0 ? l.toBusiness : l.fromBusiness))?.name;
            lines.push(<div className="row" key={l.id}><span className="main"><b>{from} → {to}</b><small>between businesses</small></span><span className="val num">{money(Math.abs(v))}</span></div>);
          }
          for (const p of activeBook.people) {
            if (business && p.businessId !== business) continue;
            const v = activeBook.balances.people[p.id] ?? 0;
            if (!v) continue;
            lines.push(<div className="row" key={p.id}><span className="main"><b>{p.name}</b><small>{v < 0 ? 'you owe' : 'owes you'}</small></span><span className={`val num ${tone(v)}`}>{money(v)}</span></div>);
          }
          return lines.length ? lines : <Empty>Nothing outstanding.</Empty>;
        })()}
      </Card>

      <Card title="Reminders" aside="promises, not movements">
        {activeBook.reminders.length === 0 ? <Empty>Nothing pending.</Empty> : activeBook.reminders.map((r) => (
          <div className="row" key={r.id}><span className="main"><b>{r.what}</b><small>{[activeBook.accounts.find((a) => a.id === r.accountId)?.name, r.note].filter(Boolean).join(' · ')}</small></span><span className="val num">{money(r.amount)}<small><button className="linkbtn" onClick={() => run(() => api.clearReminder(r.id), 'Reminder cleared.')}>clear</button></small></span></div>
        ))}
      </Card>
    </section>
  );
}

function ReportStat({ label, value, tone: valueTone = '', strong }: { label: string; value: string; tone?: string; strong?: boolean }) {
  return <div className={`report-stat${strong ? ' strong' : ''}`}><span>{label}</span><b className={`num ${valueTone}`}>{value}</b></div>;
}

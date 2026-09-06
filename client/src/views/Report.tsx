/** The whole day on one screen, with past balances rebuilt by SQL on demand. */
import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
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

  const outstandingLines: ReactElement[] = [];
  for (const loan of activeBook.loans) {
    if (business && loan.fromBusiness !== business && loan.toBusiness !== business) continue;
    const value = activeBook.balances.loans[loan.id] ?? 0;
    if (!value) continue;
    const fromBusiness = activeBook.businesses.find((item) => item.id === (value >= 0 ? loan.fromBusiness : loan.toBusiness))?.name;
    const toBusiness = activeBook.businesses.find((item) => item.id === (value >= 0 ? loan.toBusiness : loan.fromBusiness))?.name;
    outstandingLines.push(
      <div className="row" key={loan.id}>
        <span className="main"><b>{fromBusiness} → {toBusiness}</b><small>between businesses</small></span>
        <span className="val num">{money(Math.abs(value))}</span>
      </div>,
    );
  }
  for (const person of activeBook.people) {
    if (business && person.businessId !== business) continue;
    const value = activeBook.balances.people[person.id] ?? 0;
    if (!value) continue;
    outstandingLines.push(
      <div className="row" key={person.id}>
        <span className="main"><b>{person.name}</b><small>{value < 0 ? 'you owe' : 'owes you'}</small></span>
        <span className={`val num ${tone(value)}`}>{money(value)}</span>
      </div>,
    );
  }

  const cashRows = businesses.map((item) => (
    <div className="row" key={item.id}>
      <span className="main">
        <b>{item.name}</b>
        <small>{activeBook.accounts.filter((account) => account.businessId === item.id).map((account) => `${account.name} ${money(activeBook.balances.accounts[account.id] ?? 0)}`).join(' · ') || 'no accounts'}</small>
      </span>
      <span className="val num">{money(cashOf(item.id))}</span>
    </div>
  ));

  const receivedRows = received.map((entry) => (
    <div className="row" key={entry.id}>
      <span className="main"><b>{activeBook.projects.find((project) => project.id === entry.projectId)?.name ?? entry.purpose}</b><small>{activeBook.accounts.find((account) => account.id === entry.accountId)?.name}</small></span>
      <span className="val num pos">{signed(entry.amount)}</span>
    </div>
  ));

  const spentRows = spent.map((entry) => (
    <div className="row" key={entry.id}>
      <span className="main"><b>{entry.purpose}</b><small>{activeBook.accounts.find((account) => account.id === entry.accountId)?.name}</small></span>
      <span className="val num neg">{signed(-entry.amount)}</span>
    </div>
  ));

  const reminderRows = activeBook.reminders.map((reminder) => (
    <div className="row" key={reminder.id}>
      <span className="main"><b>{reminder.what}</b><small>{[activeBook.accounts.find((account) => account.id === reminder.accountId)?.name, reminder.note].filter(Boolean).join(' · ')}</small></span>
      <span className="val num">{money(reminder.amount)}<small><button className="linkbtn" onClick={() => run(() => api.clearReminder(reminder.id), 'Reminder cleared.')}>clear</button></small></span>
    </div>
  ));

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
        <select className="fi" value={business} onChange={(e) => setBusiness(e.target.value)}><option value="">All businesses</option>{book.businesses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      </div>

      {error && <Card title="Could not load this day"><Empty>{error}</Empty></Card>}

      <div className="report-summary" aria-label="Day totals">
        <ReportStat label="Cash at close" value={money(total)} strong />
        <ReportStat label="Money in" value={money(receivedTotal)} tone={receivedTotal ? 'pos' : ''} />
        <ReportStat label="Money out" value={money(spentTotal)} tone={spentTotal ? 'neg' : ''} />
        <ReportStat label="Net activity" value={signed(netActivity)} tone={tone(netActivity)} />
      </div>

      <div className="report-desktop-details">
        <Card title={`Cash at end of ${shortDate(date)}`} aside={`${businesses.length} business${businesses.length === 1 ? '' : 'es'}`}>
          {cashRows}
        </Card>

        <div className="report-flow-grid">
          <Card title="Received" aside={received.length ? money(receivedTotal) : undefined}>
            {received.length === 0 ? <Empty>Nothing received this day.</Empty> : receivedRows}
          </Card>
          <Card title="Spent" aside={spent.length ? money(spentTotal) : undefined}>
            {spent.length === 0 ? <Empty>Nothing spent this day.</Empty> : spentRows}
          </Card>
        </div>

        {credit.length > 0 && <Card title="Taken on credit" aside="not paid yet">{credit.map((entry) => <div className="row" key={entry.id}><span className="main"><b>{entry.purpose}</b><small>{activeBook.people.find((person) => person.id === entry.personId)?.name}</small></span><span className="val num neg">{money(-entry.amount)}</span></div>)}</Card>}
        {moved.length > 0 && <Card title="Moved between accounts" aside="not spending">{moved.map((entry) => <div className="row" key={entry.id}><span className="main"><b>{activeBook.accounts.find((account) => account.id === entry.accountId)?.name} → {activeBook.accounts.find((account) => account.id === entry.toAccountId)?.name}</b><small>{entry.purpose}</small></span><span className="val num">{money(entry.amount)}</span></div>)}</Card>}

        <Card title={`Outstanding at end of ${shortDate(date)}`}>
          {outstandingLines.length ? outstandingLines : <Empty>Nothing outstanding.</Empty>}
        </Card>

        <Card title="Reminders" aside="promises, not movements">
          {activeBook.reminders.length === 0 ? <Empty>Nothing pending.</Empty> : reminderRows}
        </Card>
      </div>

      <div className="report-mobile-details" aria-label="Day report details">
        <ReportDisclosure title="Cash by business" aside={`${businesses.length}`}>
          {cashRows}
        </ReportDisclosure>

        <ReportDisclosure title="Money in & out" aside={`${received.length + spent.length} entries`}>
          <div className="report-mobile-subsection"><b>Received · {money(receivedTotal)}</b>{received.length ? receivedRows : <Empty>Nothing received this day.</Empty>}</div>
          <div className="report-mobile-subsection"><b>Spent · {money(spentTotal)}</b>{spent.length ? spentRows : <Empty>Nothing spent this day.</Empty>}</div>
        </ReportDisclosure>

        {credit.length > 0 && (
          <ReportDisclosure title="Taken on credit" aside={`${credit.length}`}>
            {credit.map((entry) => <div className="row" key={entry.id}><span className="main"><b>{entry.purpose}</b><small>{activeBook.people.find((person) => person.id === entry.personId)?.name}</small></span><span className="val num neg">{money(-entry.amount)}</span></div>)}
          </ReportDisclosure>
        )}

        {moved.length > 0 && (
          <ReportDisclosure title="Account transfers" aside={`${moved.length}`}>
            {moved.map((entry) => <div className="row" key={entry.id}><span className="main"><b>{activeBook.accounts.find((account) => account.id === entry.accountId)?.name} → {activeBook.accounts.find((account) => account.id === entry.toAccountId)?.name}</b><small>{entry.purpose}</small></span><span className="val num">{money(entry.amount)}</span></div>)}
          </ReportDisclosure>
        )}

        <ReportDisclosure title="Outstanding" aside={`${outstandingLines.length}`}>
          {outstandingLines.length ? outstandingLines : <Empty>Nothing outstanding.</Empty>}
        </ReportDisclosure>

        <ReportDisclosure title="Reminders" aside={`${activeBook.reminders.length}`}>
          {activeBook.reminders.length ? reminderRows : <Empty>Nothing pending.</Empty>}
        </ReportDisclosure>
      </div>
    </section>
  );
}

function ReportStat({ label, value, tone: valueTone = '', strong }: { label: string; value: string; tone?: string; strong?: boolean }) {
  return <div className={`report-stat${strong ? ' strong' : ''}`}><span>{label}</span><b className={`num ${valueTone}`}>{value}</b></div>;
}

function ReportDisclosure({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <details className="report-disclosure">
      <summary><span>{title}</span>{aside && <small className="num">{aside}</small>}</summary>
      <div className="report-disclosure-body">{children}</div>
    </details>
  );
}

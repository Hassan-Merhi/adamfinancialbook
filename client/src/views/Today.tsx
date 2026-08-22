import type { LoadedBook } from '../api';
import { ordered } from '../../../shared/engine';
import { Card, Empty, KINDS, Row, Tile, longDate, money, shortDate, today, tone } from '../ui';
import type { Focus } from './Statement';

export default function Today({ book, open, goto }: {
  book: LoadedBook;
  open: (f: Focus) => void;
  goto: (view: 'report') => void;
}) {
  const owedToYou = book.people.reduce((s, p) => s + Math.max(0, book.balances.people[p.id] ?? 0), 0);
  const youOwe = book.people.reduce((s, p) => s + Math.min(0, book.balances.people[p.id] ?? 0), 0);
  const between = book.loans.reduce((s, l) => s + Math.abs(book.balances.loans[l.id] ?? 0), 0);
  // ordered() leaves out voided entries, which count for nothing
  const entered = ordered(book.entries).filter((e) => e.occurredOn === today());

  return (
    <>
      <p className="lede">{longDate(today())} · minus means you owe it, plus means it is owed to you.</p>

      <div className="tiles">
        <Tile label="Cash on hand" value={money(book.balances.totalCash)}
          note={`${book.accounts.length} accounts across ${book.businesses.length} businesses`} wide />
        <Tile label="Owed to you" value={money(owedToYou)} tone={owedToYou ? 'pos' : ''} />
        <Tile label="You owe" value={money(youOwe)} tone={youOwe ? 'neg' : ''} />
        <Tile label="Between businesses" value={money(between)} note="not income, not expense" />
      </div>

      <Card title="Cash by business" aside="balance now">
        {book.businesses.map((b) => (
          <Row key={b.id} title={b.name}
            sub={book.accounts.filter((a) => a.businessId === b.id).map((a) => a.name).join(' · ') || 'no accounts yet'}
            value={money(book.balances.businesses[b.id] ?? 0)} />
        ))}
      </Card>

      <Card title="Entered today" aside={entered.length ? `${entered.length} entries` : undefined}>
        {entered.length === 0
          ? <Empty>Nothing yet today. Say what happened in the box above.</Empty>
          : [...entered].reverse().map((e) => (
              <Row key={e.id} title={e.purpose}
                sub={`${KINDS[e.kind]}${e.accountId ? ` · ${book.accounts.find((a) => a.id === e.accountId)?.name}` : ''}`}
                value={money(e.amount)}
                onOpen={e.accountId ? () => open({ type: 'account', id: e.accountId! }) : undefined} />
            ))}
      </Card>

      {book.reminders.length > 0 && (
        <Card title="Allocated, not paid" aside="promises, not movements">
          {book.reminders.map((r) => (
            <Row key={r.id} title={r.what}
              sub={[book.accounts.find((a) => a.id === r.accountId)?.name, r.note].filter(Boolean).join(' · ')}
              value={money(r.amount)} />
          ))}
        </Card>
      )}

      {book.receipts.some((r) => !r.inCash) && (
        <Card title="Receipts recorded but not in cash yet">
          {book.receipts.filter((r) => !r.inCash).map((r) => (
            <Row key={r.id} title={book.projects.find((p) => p.id === r.projectId)?.name ?? 'Project'}
              sub={shortDate(r.occurredOn)} value={money(r.amount)} valueTone={tone(0)} />
          ))}
        </Card>
      )}

      <button className="btn ghost" onClick={() => goto('report')}>See the day report →</button>
    </>
  );
}

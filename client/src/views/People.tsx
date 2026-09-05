import type { LoadedBook } from '../api';
import { Card, Empty, Row, money, tone } from '../ui';
import type { Focus } from './Statement';

const GROUPS: { kind: 'receivable' | 'salary' | 'payable'; label: string; hint: string }[] = [
  { kind: 'receivable', label: 'Owe you', hint: 'Money you are waiting to collect' },
  { kind: 'salary', label: 'Payroll', hint: 'Workers, salaries and advances' },
  { kind: 'payable', label: 'Suppliers', hint: 'Money you still owe' },
];

export default function People({ book, open }: { book: LoadedBook; open: (f: Focus) => void }) {
  const owedToYou = book.people
    .filter((person) => person.kind === 'receivable')
    .reduce((sum, person) => sum + Math.max(0, book.balances.people[person.id] ?? 0), 0);
  const youOwe = book.people
    .filter((person) => person.kind !== 'receivable')
    .reduce((sum, person) => sum + Math.abs(Math.min(0, book.balances.people[person.id] ?? 0)), 0);

  return (
    <div className="operations-page people-page">
      <div className="operations-hero">
        <div>
          <span className="operations-eyebrow">People</span>
          <h2>Who owes what</h2>
          <p>People stay separated by role so supplier, payroll and loan balances never get mixed.</p>
        </div>
        <div className="operations-stats" aria-label="People summary">
          <div><span>People</span><b className="num">{book.people.length}</b></div>
          <div><span>Owed to you</span><b className="num pos">{money(owedToYou)}</b></div>
          <div className={youOwe ? 'needs-action' : ''}><span>You owe</span><b className="num">{money(youOwe)}</b></div>
        </div>
      </div>

      {book.people.length === 0 && (
        <Card title="People"><Empty>Nobody yet. Say “add supplier …” or “add payroll worker … salary …”.</Empty></Card>
      )}

      {GROUPS.map(({ kind, label, hint }) => {
        const list = book.people.filter((person) => person.kind === kind);
        if (!list.length) return null;
        const groupBalance = list.reduce((sum, person) => sum + (book.balances.people[person.id] ?? 0), 0);
        return (
          <Card key={kind} title={label} aside={`${list.length} · ${money(groupBalance)}`}>
            <div className="operations-section-note">{hint}</div>
            <div className="operations-list">
              {list.map((person) => {
                const balance = book.balances.people[person.id] ?? 0;
                const business = book.businesses.find((item) => item.id === person.businessId)?.name;
                return (
                  <Row
                    key={person.id}
                    title={person.name}
                    sub={kind === 'salary'
                      ? [business, person.role, `salary ${money(person.salary)}`].filter(Boolean).join(' · ')
                      : [business, person.role].filter(Boolean).join(' · ')}
                    value={money(balance)}
                    valueTone={tone(balance)}
                    valueSub={balance < 0 ? 'you owe' : balance > 0 ? 'owes you' : 'settled'}
                    onOpen={() => open({ type: 'person', id: person.id })}
                  />
                );
              })}
            </div>
          </Card>
        );
      })}

      <details className="operations-explainer">
        <summary>How to read these balances</summary>
        <p>Minus means you owe them. Plus means they owe you. A person can appear in different roles, but each role keeps its own balance.</p>
      </details>
    </div>
  );
}

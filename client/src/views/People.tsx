import type { LoadedBook } from '../api';
import { Card, Empty, Row, money, tone } from '../ui';
import type { Focus } from './Statement';

const GROUPS: { kind: 'receivable' | 'salary' | 'payable'; label: string }[] = [
  { kind: 'receivable', label: 'Owe you' },
  { kind: 'salary', label: 'Payroll' },
  { kind: 'payable', label: 'Suppliers' },
];

export default function People({ book, open }: { book: LoadedBook; open: (f: Focus) => void }) {
  return (
    <>
      <p className="lede">
        A person can owe you, work for you, and sell to you at the same time. Three lists, never
        mixed. Minus means you owe them, plus means they owe you.
      </p>

      {book.people.length === 0 && (
        <Card title="People"><Empty>Nobody yet. Say “add supplier …” or “add payroll worker … salary …”.</Empty></Card>
      )}

      {GROUPS.map(({ kind, label }) => {
        const list = book.people.filter((p) => p.kind === kind);
        if (!list.length) return null;
        return (
          <Card key={kind} title={label}>
            {list.map((p) => {
              const balance = book.balances.people[p.id] ?? 0;
              return (
                <Row key={p.id} title={p.name}
                  sub={kind === 'salary'
                    ? `${p.role} · salary ${money(p.salary)}`
                    : p.role}
                  value={money(balance)} valueTone={tone(balance)}
                  onOpen={() => open({ type: 'person', id: p.id })} />
              );
            })}
          </Card>
        );
      })}
    </>
  );
}

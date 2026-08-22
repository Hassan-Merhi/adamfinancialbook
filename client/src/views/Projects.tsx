import type { LoadedBook } from '../api';
import { Card, Empty, Row, money, shortDate } from '../ui';
import type { Focus } from './Statement';

export default function Projects({ book, open }: { book: LoadedBook; open: (f: Focus) => void }) {
  return (
    <>
      <p className="lede">
        What each job has paid you. This has nothing to do with what is left in cash.
      </p>

      <Card title="Projects" aside="received to date">
        {book.projects.length === 0 && <Empty>No projects yet. Say “new project … for …” in the box above.</Empty>}
        {book.projects.map((p) => {
          const received = book.balances.projects[p.id] ?? 0;
          const waiting = book.receipts
            .filter((r) => r.projectId === p.id && !r.inCash)
            .reduce((s, r) => s + r.amount, 0);
          return (
            <Row key={p.id} title={p.name}
              sub={`${p.scope || 'project'}${waiting ? ` · ${money(waiting)} recorded but not in cash yet` : ''}`}
              value={money(received)} valueSub="received"
              onOpen={() => open({ type: 'project', id: p.id })} />
          );
        })}
      </Card>

      {book.receipts.some((r) => !r.inCash) && (
        <Card title="Recorded, not yet in an account">
          {book.receipts.filter((r) => !r.inCash).map((r) => (
            <Row key={r.id}
              title={book.projects.find((p) => p.id === r.projectId)?.name ?? 'Project'}
              sub={shortDate(r.occurredOn)}
              value={money(r.amount)} />
          ))}
        </Card>
      )}

      <div className="rule">
        <b>The rule that keeps this honest.</b> A receipt is counted once, on the day the job pays.
        When that same money later lands in an account it is a cash movement — not a second receipt.
      </div>
    </>
  );
}

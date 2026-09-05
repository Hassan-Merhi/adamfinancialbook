import type { LoadedBook } from '../api';
import { Card, Empty, Row, money, shortDate } from '../ui';
import type { Focus } from './Statement';
import '../operations-mobile.css';

export default function Projects({ book, open }: { book: LoadedBook; open: (f: Focus) => void }) {
  const waitingReceipts = book.receipts.filter((receipt) => !receipt.inCash);
  const waitingTotal = waitingReceipts.reduce((sum, receipt) => sum + receipt.amount, 0);
  const receivedTotal = book.projects.reduce((sum, project) => sum + (book.balances.projects[project.id] ?? 0), 0);

  return (
    <div className="operations-page projects-page">
      <div className="operations-hero">
        <div>
          <span className="operations-eyebrow">Projects</span>
          <h2>Jobs at a glance</h2>
          <p>Tap a project to see every receipt and transaction behind it.</p>
        </div>
        <div className="operations-stats" aria-label="Project summary">
          <div><span>Projects</span><b className="num">{book.projects.length}</b></div>
          <div><span>Received</span><b className="num">{money(receivedTotal)}</b></div>
          <div className={waitingTotal ? 'needs-action' : ''}><span>Waiting for cash</span><b className="num">{money(waitingTotal)}</b></div>
        </div>
      </div>

      <Card title="Projects" aside={book.projects.length ? `${book.projects.length} total` : undefined}>
        {book.projects.length === 0 && <Empty>No projects yet. Say “new project … for …” in the box above.</Empty>}
        <div className="operations-list">
          {book.projects.map((project) => {
            const received = book.balances.projects[project.id] ?? 0;
            const waiting = waitingReceipts
              .filter((receipt) => receipt.projectId === project.id)
              .reduce((sum, receipt) => sum + receipt.amount, 0);
            const business = book.businesses.find((item) => item.id === project.businessId)?.name;
            return (
              <Row
                key={project.id}
                title={project.name}
                sub={[business, project.scope || 'Project', waiting ? `${money(waiting)} waiting for cash` : 'Up to date'].filter(Boolean).join(' · ')}
                value={money(received)}
                valueSub="received"
                onOpen={() => open({ type: 'project', id: project.id })}
              />
            );
          })}
        </div>
      </Card>

      {waitingReceipts.length > 0 && (
        <Card title="Waiting to reach cash" aside={`${waitingReceipts.length} recorded`}>
          <div className="operations-list waiting-list">
            {waitingReceipts.map((receipt) => (
              <Row
                key={receipt.id}
                title={book.projects.find((project) => project.id === receipt.projectId)?.name ?? 'Project'}
                sub={`${shortDate(receipt.occurredOn)} · recorded already, not a new receipt when banked`}
                value={money(receipt.amount)}
                onOpen={() => open({ type: 'project', id: receipt.projectId })}
              />
            ))}
          </div>
        </Card>
      )}

      <details className="operations-explainer">
        <summary>How project receipts work</summary>
        <p>A receipt is counted once when the job pays. When the same money later lands in an account, that is only a cash movement—not a second receipt.</p>
      </details>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { api, type DelegatedSpendItem, type LoadedBook } from '../api';
import { Card, Empty, Row, money, shortDate } from '../ui';
import type { Focus } from './Statement';

function spentOnProject(book: LoadedBook, projectId: string): number {
  return book.entries.reduce((sum, entry) => sum + entry.effects.reduce((entrySum, effect) =>
    entrySum + (effect.type === 'cost' && effect.targetId === projectId ? Number(effect.delta) : 0), 0), 0);
}

export default function Projects({
  book,
  open,
  reload,
}: {
  book: LoadedBook;
  open: (f: Focus) => void;
  reload: () => Promise<void>;
}) {
  const [spending, setSpending] = useState<DelegatedSpendItem[] | null>(null);
  const [allocatorVisible, setAllocatorVisible] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [businessId, setBusinessId] = useState(book.businesses[0]?.id ?? '');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const loadSpending = async () => {
    try {
      const result = await api.delegatedSpending();
      setSpending(result.items);
      setAllocatorVisible(true);
    } catch (error) {
      // Delegated users receive a 403 here; the allocation controls are owner-only.
      if (!(error instanceof Error) || !error.message.includes('(403)')) setMessage((error as Error).message);
    }
  };

  useEffect(() => { void loadSpending(); }, []);

  useEffect(() => {
    if (!businessId && book.businesses[0]?.id) setBusinessId(book.businesses[0].id);
    if (projectId && !book.projects.some((project) => project.id === projectId && project.businessId === businessId)) {
      setProjectId('');
    }
  }, [book.businesses, book.projects, businessId, projectId]);

  const unallocated = useMemo(
    () => (spending ?? []).filter((item) => !item.project_id && !item.for_business),
    [spending],
  );
  const selectedItems = useMemo(
    () => unallocated.filter((item) => selected.includes(item.id)),
    [unallocated, selected],
  );
  const selectedTotal = selectedItems.reduce((sum, item) => sum + Number(item.amount), 0);
  const businessProjects = book.projects.filter((project) => project.businessId === businessId);

  const toggle = (id: string) => {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const selectAll = () => {
    const ids = unallocated.slice(0, 500).map((item) => item.id);
    setSelected(selected.length === ids.length && ids.every((id) => selected.includes(id)) ? [] : ids);
  };

  const allocate = async () => {
    if (!selected.length || !businessId) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await api.allocateDelegatedSpending(selected, businessId, projectId || null);
      setMessage(`${result.count} ${result.count === 1 ? 'expense' : 'expenses'} allocated · ${money(result.total)} total.`);
      setSelected([]);
      await Promise.all([loadSpending(), reload()]);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="lede">
        What each job has paid you, what has been spent on it, and where delegated spending belongs.
      </p>

      {allocatorVisible && (
        <Card title="Allocate delegated spending" aside={`${unallocated.length} waiting`}>
          <div className="note">
            Give someone money, let them record 1 or 100 expenses from their prompt, then classify those expenses here.
            The original cash movements and descriptions stay unchanged.
          </div>

          {unallocated.length === 0 ? (
            <Empty>All delegated spending has been allocated.</Empty>
          ) : (
            <>
              <div className="form">
                <div className="f"><label>Construction business</label>
                  <select value={businessId} onChange={(event) => { setBusinessId(event.target.value); setProjectId(''); }}>
                    {book.businesses.map((business) => <option key={business.id} value={business.id}>{business.name}</option>)}
                  </select>
                </div>
                <div className="f"><label>Project / job</label>
                  <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                    <option value="">Business only — no specific project</option>
                    {businessProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </div>
                <button className="btn" type="button" onClick={selectAll} disabled={!unallocated.length || busy}>
                  {selected.length && selected.length === Math.min(unallocated.length, 500) ? 'Clear selection' : `Select all${unallocated.length > 500 ? ' 500' : ''}`}
                </button>
                <button className="btn" type="button" onClick={() => void allocate()} disabled={!selected.length || !businessId || busy}>
                  {busy ? 'Allocating…' : `Allocate ${selected.length || ''}`}
                </button>
              </div>

              {selected.length > 0 && (
                <div className="note ok">
                  Selected: <b>{selected.length}</b> · <b>{money(selectedTotal)}</b>
                  {projectId ? ` → ${businessProjects.find((project) => project.id === projectId)?.name ?? 'project'}` : ''}
                </div>
              )}

              {unallocated.map((item) => {
                const payerBusiness = book.businesses.find((business) => business.id === item.payer_business_id)?.name ?? 'Business';
                return (
                  <label className="row" key={item.id} style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggle(item.id)} />
                    <span className="main">
                      <b>{item.purpose || 'Expense'}</b>
                      <small>{shortDate(item.occurred_on)} · {item.spender_email} · {item.account_name} · paid by {payerBusiness}</small>
                    </span>
                    <span className="num">{money(Number(item.amount))}</span>
                  </label>
                );
              })}
            </>
          )}

          {message && <div className="note" role="status">{message}</div>}
        </Card>
      )}

      <Card title="Projects" aside="received / spent">
        {book.projects.length === 0 && <Empty>No projects yet. Say “new project … for …” in the box above.</Empty>}
        {book.projects.map((p) => {
          const received = book.balances.projects[p.id] ?? 0;
          const spent = spentOnProject(book, p.id);
          const waiting = book.receipts
            .filter((r) => r.projectId === p.id && !r.inCash)
            .reduce((s, r) => s + r.amount, 0);
          return (
            <Row key={p.id} title={p.name}
              sub={`${p.scope || 'project'} · ${money(spent)} spent${waiting ? ` · ${money(waiting)} recorded but not in cash yet` : ''}`}
              value={money(received)} valueSub={`${money(received - spent)} after spend`}
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
        Allocating a delegated expense does not rewrite the spend; it adds the correct project cost and, when another business paid it, the correct intercompany position.
      </div>
    </>
  );
}
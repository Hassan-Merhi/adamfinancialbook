import { useEffect, useMemo, useState } from 'react';
import { api, type DelegatedExpenseReview, type LoadedBook } from '../api';
import { Card, money, shortDate } from '../ui';
import './ExpenseReviewQueue.css';

export default function ExpenseReviewQueue({ items, book, refresh, say }: {
  items: DelegatedExpenseReview[];
  book: LoadedBook;
  refresh: () => Promise<void>;
  say: (text: string, bad?: boolean) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [businessId, setBusinessId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);

  const itemIds = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  useEffect(() => {
    setSelected((current) => current.filter((id) => itemIds.has(id)));
  }, [itemIds]);

  const projects = businessId
    ? book.projects.filter((project) => project.businessId === businessId)
    : [];
  const selectedItems = items.filter((item) => selected.includes(item.id));
  const selectedTotal = selectedItems.reduce((sum, item) => sum + item.amount, 0);
  const allSelected = items.length > 0 && selected.length === items.length;

  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => checked
      ? [...new Set([...current, id])]
      : current.filter((value) => value !== id));
  };

  const changeBusiness = (next: string) => {
    setBusinessId(next);
    setProjectId('');
  };

  const assign = async () => {
    if (!selected.length || !businessId) return;
    setBusy(true);
    try {
      const result = await api.assignExpenseReviews(
        selected,
        businessId,
        projectId || null,
        category.trim(),
      );
      await refresh();
      setSelected([]);
      setCategory('');
      say(`${result.count} ${result.count === 1 ? 'expense' : 'expenses'} assigned. Cash was not changed again.`);
    } catch (error) {
      say((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Expenses to assign" aside={`${items.length} waiting`}>
      <div className="expense-review-note">
        <b>Cash is already posted.</b>
        <span>Choose where these expenses belong. Assigning them will not deduct the money again.</span>
      </div>

      <div className="expense-review-controls">
        <label>
          <span>Business</span>
          <select value={businessId} onChange={(event) => changeBusiness(event.target.value)}>
            <option value="">Choose business…</option>
            {book.businesses.map((business) => (
              <option key={business.id} value={business.id}>{business.name}</option>
            ))}
          </select>
        </label>

        <label>
          <span>Project</span>
          <select value={projectId} disabled={!businessId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">General / no project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>

        <label>
          <span>Category</span>
          <input
            value={category}
            maxLength={80}
            onChange={(event) => setCategory(event.target.value)}
            placeholder="e.g. Materials"
          />
        </label>

        <div className="expense-review-commit">
          <span>{selected.length} selected · {money(selectedTotal)}</span>
          <button className="btn" disabled={!selected.length || !businessId || busy} onClick={() => void assign()}>
            {busy ? 'Assigning…' : selected.length > 1 ? 'Assign selected' : 'Assign expense'}
          </button>
        </div>
      </div>

      <div className="expense-review-selectbar">
        <button
          className="btn ghost small"
          disabled={busy}
          onClick={() => setSelected(allSelected ? [] : items.map((item) => item.id))}
        >
          {allSelected ? 'Clear selection' : 'Select all'}
        </button>
        <span className="muted small">You can assign one expense or hundreds in batches of up to 200.</span>
      </div>

      <div className="expense-review-list">
        {items.map((item) => {
          const checked = selected.includes(item.id);
          return (
            <label className={`expense-review-row${checked ? ' selected' : ''}`} key={item.id}>
              <input
                type="checkbox"
                checked={checked}
                disabled={busy}
                onChange={(event) => toggle(item.id, event.target.checked)}
              />
              <span className="expense-review-copy">
                <b>{item.purpose || item.raw || 'Cash expense'}</b>
                <small>
                  {[item.actor_email, item.account_name, shortDate(item.occurred_on)].filter(Boolean).join(' · ')}
                </small>
              </span>
              <strong className="num">{money(item.amount)}</strong>
            </label>
          );
        })}
      </div>
    </Card>
  );
}

import type { LoadedBook } from '../api';
import { isProjectedEntry } from '../offline-projection';
import { ordered } from '../../../shared/engine';
import { Card, Empty, KINDS, Row, longDate, money, shortDate, signed, today, tone } from '../ui';
import type { Focus } from './Statement';

export default function Today({ book, open, goto, attentionCount }: {
  book: LoadedBook;
  open: (f: Focus) => void;
  goto: (view: 'attention' | 'money') => void;
  attentionCount: number;
}) {
  const date = today();
  const activity = ordered(book.entries);
  const enteredToday = activity.filter((entry) => entry.occurredOn === date);
  const recent = [...activity].reverse().slice(0, 6);
  const pendingToday = enteredToday.filter(isProjectedEntry).length;

  const accountMoves = enteredToday.flatMap((entry) =>
    entry.effects.filter((effect) => effect.type === 'account'),
  );
  const moneyIn = accountMoves.reduce((sum, effect) => sum + Math.max(0, effect.delta), 0);
  const moneyOut = Math.abs(accountMoves.reduce((sum, effect) => sum + Math.min(0, effect.delta), 0));
  const netMovement = moneyIn - moneyOut;

  const accountName = (accountId?: string | null) =>
    accountId ? book.accounts.find((account) => account.id === accountId)?.name : undefined;

  return (
    <div className="today-page daily-page">
      <section className="today-hero" aria-label="Today overview">
        <div className="today-hero-copy">
          <span className="daily-eyebrow">Today · {longDate(date)}</span>
          <span className="today-cash-label">Cash on hand</span>
          <strong className="today-cash num">{money(book.balances.totalCash)}</strong>
          <span className="today-cash-meta">
            {book.accounts.length} {book.accounts.length === 1 ? 'account' : 'accounts'} · {book.businesses.length} {book.businesses.length === 1 ? 'business' : 'businesses'}
          </span>
        </div>
        <button className="daily-hero-action" type="button" onClick={() => goto('money')}>View money</button>
      </section>

      <div className="today-pulse" aria-label="Today's cash movement">
        <div className="today-pulse-item">
          <span>In</span>
          <b className="num pos">{money(moneyIn)}</b>
        </div>
        <div className="today-pulse-item">
          <span>Out</span>
          <b className="num neg">{money(moneyOut)}</b>
        </div>
        <div className="today-pulse-item">
          <span>Net</span>
          <b className={`num ${tone(netMovement)}`}>{signed(netMovement)}</b>
        </div>
      </div>

      {attentionCount > 0 ? (
        <button className="today-attention" type="button" onClick={() => goto('attention')}>
          <span className="today-attention-icon" aria-hidden="true">!</span>
          <span className="today-attention-copy">
            <b>{attentionCount} {attentionCount === 1 ? 'item needs' : 'items need'} attention</b>
            <small>Approvals, cash handoffs, receipts, reminders, and money in limbo.</small>
          </span>
          <span className="chev" aria-hidden="true">›</span>
        </button>
      ) : (
        <div className="today-clear" role="status">
          <span aria-hidden="true">✓</span>
          <span><b>All clear</b><small>Nothing needs a decision right now.</small></span>
        </div>
      )}

      <Card title="Recent activity" aside={recent.length ? `${recent.length} latest` : undefined}>
        {recent.length === 0
          ? <Empty>No activity yet. Say what happened in the prompt below.</Empty>
          : recent.map((entry) => {
              const cashDelta = entry.effects
                .filter((effect) => effect.type === 'account')
                .reduce((sum, effect) => sum + effect.delta, 0);
              const account = accountName(entry.accountId);
              const projected = isProjectedEntry(entry);
              return (
                <Row
                  key={entry.id}
                  title={entry.purpose}
                  sub={[projected ? 'Pending sync · projected' : shortDate(entry.occurredOn), KINDS[entry.kind], account].filter(Boolean).join(' · ')}
                  value={money(entry.amount)}
                  valueTone={tone(cashDelta)}
                  onOpen={!projected && entry.accountId ? () => open({ type: 'account', id: entry.accountId! }) : undefined}
                />
              );
            })}
      </Card>

      {enteredToday.length > 0 && (
        <div className="today-footnote">
          {enteredToday.length} {enteredToday.length === 1 ? 'entry' : 'entries'} today · net cash movement {signed(netMovement)}
          {pendingToday > 0 ? ` · ${pendingToday} pending sync` : ''}
        </div>
      )}
    </div>
  );
}

import type { LoadedBook } from '../api';
import { ordered } from '../../../shared/engine';
import { Card, Empty, KINDS, Row, Tile, longDate, money, shortDate, signed, today, tone } from '../ui';
import type { Focus } from './Statement';

export default function Today({ book, open, goto, attentionCount }: {
  book: LoadedBook;
  open: (f: Focus) => void;
  goto: (view: 'attention') => void;
  attentionCount: number;
}) {
  const date = today();
  const activity = ordered(book.entries);
  const enteredToday = activity.filter((entry) => entry.occurredOn === date);
  const recent = [...activity].reverse().slice(0, 5);

  const accountMoves = enteredToday.flatMap((entry) =>
    entry.effects.filter((effect) => effect.type === 'account'),
  );
  const moneyIn = accountMoves.reduce((sum, effect) => sum + Math.max(0, effect.delta), 0);
  const moneyOut = Math.abs(accountMoves.reduce((sum, effect) => sum + Math.min(0, effect.delta), 0));
  const netMovement = moneyIn - moneyOut;

  const accountName = (accountId?: string | null) =>
    accountId ? book.accounts.find((account) => account.id === accountId)?.name : undefined;

  return (
    <>
      <div className="tiles">
        <Tile
          label="Cash on hand"
          value={money(book.balances.totalCash)}
          note={`${longDate(date)} · ${book.accounts.length} ${book.accounts.length === 1 ? 'account' : 'accounts'} across ${book.businesses.length} ${book.businesses.length === 1 ? 'business' : 'businesses'}`}
        />
      </div>

      <Card title="Needs attention" aside={attentionCount ? `${attentionCount} open` : 'all clear'}>
        {attentionCount === 0
          ? <Empty>Nothing needs your attention right now.</Empty>
          : <Row
              title={`${attentionCount} ${attentionCount === 1 ? 'item needs' : 'items need'} a decision or follow-up`}
              sub="Approvals, cash handoffs, missing receipts, reminders, and money still in limbo — all in one place."
              value="Open"
              onOpen={() => goto('attention')}
            />}
      </Card>

      <Card title="Recent activity" aside={recent.length ? 'latest 5' : undefined}>
        {recent.length === 0
          ? <Empty>No activity yet. Say what happened in the prompt above.</Empty>
          : recent.map((entry) => {
              const cashDelta = entry.effects
                .filter((effect) => effect.type === 'account')
                .reduce((sum, effect) => sum + effect.delta, 0);
              const account = accountName(entry.accountId);
              return (
                <Row
                  key={entry.id}
                  title={entry.purpose}
                  sub={[shortDate(entry.occurredOn), KINDS[entry.kind], account].filter(Boolean).join(' · ')}
                  value={money(entry.amount)}
                  valueTone={tone(cashDelta)}
                  onOpen={entry.accountId ? () => open({ type: 'account', id: entry.accountId! }) : undefined}
                />
              );
            })}
      </Card>

      <Card title="Today's movement" aside={enteredToday.length ? `${enteredToday.length} ${enteredToday.length === 1 ? 'entry' : 'entries'}` : 'no entries'}>
        <Row title="Money in" sub="cash that entered accounts today" value={money(moneyIn)} valueTone={moneyIn ? 'pos' : ''} />
        <Row title="Money out" sub="cash that left accounts today" value={money(moneyOut)} valueTone={moneyOut ? 'neg' : ''} />
        <Row title="Net cash movement" sub="money in minus money out" value={signed(netMovement)} valueTone={tone(netMovement)} />
      </Card>
    </>
  );
}

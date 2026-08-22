/**
 * Where the money sits and who owes who — on one page, because a business's
 * cash and its obligations are read together or not at all.
 */
import type { LoadedBook } from '../api';
import { Card, Row, Tile, money, tone } from '../ui';
import type { Focus } from './Statement';

export default function Money({ book, open }: { book: LoadedBook; open: (f: Focus) => void }) {
  const totalCash = book.balances.totalCash;
  const between = book.loans.reduce((s, l) => s + Math.abs(book.balances.loans[l.id] ?? 0), 0);

  return (
    <>
      <p className="lede">
        Minus is money a business must return, plus is money it is waiting on.
        Tap any line for its statement.
      </p>

      <div className="tiles">
        <Tile label="Cash on hand" value={money(totalCash)} note={`${book.accounts.length} accounts`} />
        <Tile label="Owed between businesses" value={money(between)} note="not income, not expense" />
      </div>

      {book.businesses.map((b) => {
        const accounts = book.accounts.filter((a) => a.businessId === b.id);
        const loans = book.loans.filter((l) =>
          (l.fromBusiness === b.id || l.toBusiness === b.id) && (book.balances.loans[l.id] ?? 0) !== 0);
        return (
          <Card key={b.id} title={b.name} aside={money(book.balances.businesses[b.id] ?? 0)}>
            {accounts.map((a) => (
              <Row key={a.id} title={a.name} sub="cash account"
                value={money(book.balances.accounts[a.id] ?? 0)}
                onOpen={() => open({ type: 'account', id: a.id })} />
            ))}
            {loans.map((l) => {
              const raw = book.balances.loans[l.id] ?? 0;
              const v = l.fromBusiness === b.id ? -raw : raw;   // from this business's side
              const otherId = l.fromBusiness === b.id ? l.toBusiness : l.fromBusiness;
              const other = book.businesses.find((x) => x.id === otherId)?.name;
              return (
                <Row key={l.id}
                  title={`${v < 0 ? 'Owes' : 'Owed by'} ${other}`}
                  sub={v < 0 ? 'must be returned' : 'waiting on it'}
                  value={money(v)} valueTone={tone(v)}
                  onOpen={() => open({ type: 'loan', fromBusiness: l.fromBusiness, toBusiness: l.toBusiness, view: b.id })} />
              );
            })}
            {accounts.length === 0 && loans.length === 0 && (
              <div className="row muted" style={{ fontSize: 13.5 }}>No accounts yet.</div>
            )}
          </Card>
        );
      })}

      <div className="notes2">
        <div className="rule"><b>Moving is not spending.</b> Cash going from one of your accounts to
          another changes two balances and nothing else. Only money leaving the group is an expense.</div>
        <div className="rule"><b>Direction, once and for all.</b> Money leaving A for B always reduces
          "A owes B". It never creates a new debt the other way.</div>
      </div>
    </>
  );
}

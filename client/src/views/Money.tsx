/**
 * Where the money sits and who owes who — on one page, because a business's
 * cash and its obligations are read together or not at all.
 */
import { useEffect, useMemo, useState } from 'react';
import type { LoadedBook } from '../api';
import { loadPinnedAccounts, normalizePinnedAccounts, savePinnedAccounts, togglePinnedAccount } from '../favorites';
import { Card, Row, Tile, money, tone } from '../ui';
import type { Account } from '../../../shared/types';
import type { Focus } from './Statement';

export default function Money({ book, open }: { book: LoadedBook; open: (f: Focus) => void }) {
  const totalCash = book.balances.totalCash;
  const between = book.loans.reduce((s, l) => s + Math.abs(book.balances.loans[l.id] ?? 0), 0);
  const validAccountIds = useMemo(() => book.accounts.map((account) => account.id), [book.accounts]);
  const validKey = validAccountIds.join('|');
  const [pinned, setPinned] = useState<string[]>(() => normalizePinnedAccounts(loadPinnedAccounts(), validAccountIds));

  useEffect(() => {
    setPinned((current) => {
      const next = normalizePinnedAccounts(current, validAccountIds);
      savePinnedAccounts(next);
      return next;
    });
  }, [validKey]);

  const pinnedAccounts = pinned
    .map((id) => book.accounts.find((account) => account.id === id))
    .filter((account): account is Account => !!account);

  const togglePin = (id: string) => {
    setPinned((current) => {
      const next = togglePinnedAccount(current, id, validAccountIds);
      savePinnedAccounts(next);
      return next;
    });
  };

  const accountLine = (account: Account, businessName?: string) => (
    <AccountLine
      key={account.id}
      account={account}
      businessName={businessName}
      balance={book.balances.accounts[account.id] ?? 0}
      pinned={pinned.includes(account.id)}
      onPin={() => togglePin(account.id)}
      onOpen={() => open({ type: 'account', id: account.id })}
    />
  );

  return (
    <>
      <p className="lede">
        Minus is money a business must return, plus is money it is waiting on.
        Tap any line for its statement. Pin the accounts you check most often.
      </p>

      <div className="tiles">
        <Tile label="Cash on hand" value={money(totalCash)} note={`${book.accounts.length} accounts`} />
        <Tile label="Owed between businesses" value={money(between)} note="not income, not expense" />
      </div>

      {pinnedAccounts.length > 0 && (
        <Card title="Pinned accounts" aside={`${pinnedAccounts.length} quick ${pinnedAccounts.length === 1 ? 'account' : 'accounts'}`}>
          <div className="pinned-account-card">
            {pinnedAccounts.map((account) => accountLine(
              account,
              book.businesses.find((business) => business.id === account.businessId)?.name,
            ))}
          </div>
        </Card>
      )}

      {book.businesses.map((b) => {
        const accounts = book.accounts.filter((a) => a.businessId === b.id);
        const loans = book.loans.filter((l) =>
          (l.fromBusiness === b.id || l.toBusiness === b.id) && (book.balances.loans[l.id] ?? 0) !== 0);
        return (
          <Card key={b.id} title={b.name} aside={money(book.balances.businesses[b.id] ?? 0)}>
            {accounts.map((account) => accountLine(account))}
            {loans.map((l) => {
              const raw = book.balances.loans[l.id] ?? 0;
              const v = l.fromBusiness === b.id ? -raw : raw;
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

function AccountLine({ account, businessName, balance, pinned, onPin, onOpen }: {
  account: Account;
  businessName?: string;
  balance: number;
  pinned: boolean;
  onPin: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="money-account-line">
      <button className="row link money-account-open" onClick={onOpen} aria-label={`Open ${account.name} statement`}>
        <span className="main">
          <b>{account.name}</b>
          <small>{businessName ? `${businessName} · cash account` : 'cash account'}</small>
        </span>
        <span className="val num">{money(balance)}</span>
        <span className="chev" aria-hidden="true">›</span>
      </button>
      <button
        type="button"
        className="pin-account"
        aria-label={pinned ? `Unpin ${account.name}` : `Pin ${account.name}`}
        title={pinned ? 'Unpin account' : 'Pin account'}
        aria-pressed={pinned}
        onClick={onPin}
      >{pinned ? '★' : '☆'}</button>
    </div>
  );
}

/**
 * Where the money sits and who owes who — on one page, because a business's
 * cash and its obligations are read together or not at all.
 */
import { useEffect, useMemo, useState } from 'react';
import type { LoadedBook } from '../api';
import { loadPinnedAccounts, normalizePinnedAccounts, savePinnedAccounts, togglePinnedAccount } from '../favorites';
import { Card, Row, money, tone } from '../ui';
import type { Account } from '../../../shared/types';
import type { Focus } from './Statement';

export default function Money({ book, open }: { book: LoadedBook; open: (f: Focus) => void }) {
  const totalCash = book.balances.totalCash;
  const between = book.loans.reduce((sum, loan) => sum + Math.abs(book.balances.loans[loan.id] ?? 0), 0);
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

  const assignedBusinessIds = new Set(book.businesses.map((business) => business.id));
  const standaloneAccounts = book.accounts.filter((account) => !account.businessId || !assignedBusinessIds.has(account.businessId));

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

  const loanLine = (loan: LoadedBook['loans'][number], businessId: string) => {
    const raw = book.balances.loans[loan.id] ?? 0;
    const value = loan.fromBusiness === businessId ? -raw : raw;
    const otherId = loan.fromBusiness === businessId ? loan.toBusiness : loan.fromBusiness;
    const other = book.businesses.find((candidate) => candidate.id === otherId)?.name ?? 'another business';
    return (
      <Row key={loan.id}
        title={`${value < 0 ? 'Owes' : 'Owed by'} ${other}`}
        sub={value < 0 ? 'must be returned' : 'waiting on it'}
        value={money(value)} valueTone={tone(value)}
        onOpen={() => open({ type: 'loan', fromBusiness: loan.fromBusiness, toBusiness: loan.toBusiness, view: businessId })} />
    );
  };

  return (
    <div className="money-page daily-page">
      <section className="money-hero" aria-label="Money overview">
        <span className="daily-eyebrow">Money</span>
        <span className="money-hero-label">Cash on hand</span>
        <strong className="money-hero-value num">{money(totalCash)}</strong>
        <div className="money-hero-meta">
          <span>{book.accounts.length} {book.accounts.length === 1 ? 'account' : 'accounts'}</span>
          <span>{book.businesses.length} {book.businesses.length === 1 ? 'business' : 'businesses'}</span>
          {between > 0 && <span>{money(between)} between businesses</span>}
        </div>
      </section>

      {pinnedAccounts.length > 0 && (
        <Card title="Quick accounts" aside={`${pinnedAccounts.length} pinned`}>
          <div className="pinned-account-card">
            {pinnedAccounts.map((account) => accountLine(
              account,
              account.businessId ? book.businesses.find((business) => business.id === account.businessId)?.name : undefined,
            ))}
          </div>
        </Card>
      )}

      {standaloneAccounts.length > 0 && (
        <Card title="Standalone accounts" aside={money(standaloneAccounts.reduce((sum, account) => sum + (book.balances.accounts[account.id] ?? 0), 0))}>
          {standaloneAccounts.map((account) => accountLine(account, 'No business assigned'))}
        </Card>
      )}

      <div className="money-businesses money-businesses-desktop">
        {book.businesses.map((business) => {
          const accounts = book.accounts.filter((account) => account.businessId === business.id);
          const loans = book.loans.filter((loan) =>
            (loan.fromBusiness === business.id || loan.toBusiness === business.id) && (book.balances.loans[loan.id] ?? 0) !== 0);
          const businessBalance = book.balances.businesses[business.id] ?? 0;

          return (
            <Card key={business.id}
              title={<span className="money-business-title">{business.name}<small>{accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}{loans.length ? ` · ${loans.length} intercompany` : ''}</small></span>}
              aside={money(businessBalance)}>
              {accounts.map((account) => accountLine(account))}
              {loans.map((loan) => loanLine(loan, business.id))}
              {accounts.length === 0 && loans.length === 0 && (
                <div className="row muted" style={{ fontSize: 13.5 }}>No money activity here yet.</div>
              )}
            </Card>
          );
        })}
      </div>

      <div className="money-businesses-mobile" aria-label="Business money">
        {book.businesses.map((business) => {
          const accounts = book.accounts.filter((account) => account.businessId === business.id);
          const loans = book.loans.filter((loan) =>
            (loan.fromBusiness === business.id || loan.toBusiness === business.id) && (book.balances.loans[loan.id] ?? 0) !== 0);
          const businessBalance = book.balances.businesses[business.id] ?? 0;
          return (
            <details className="money-business-details" key={business.id}>
              <summary>
                <span className="money-business-summary-copy">
                  <b>{business.name}</b>
                  <small>{accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}{loans.length ? ` · ${loans.length} intercompany` : ''}</small>
                </span>
                <span className="money-business-summary-balance num">{money(businessBalance)}</span>
                <span className="money-business-summary-chevron" aria-hidden="true">⌄</span>
              </summary>
              <div className="money-business-body">
                {accounts.map((account) => accountLine(account))}
                {loans.map((loan) => loanLine(loan, business.id))}
                {accounts.length === 0 && loans.length === 0 && (
                  <div className="money-business-empty">No money activity here yet.</div>
                )}
              </div>
            </details>
          );
        })}
      </div>

      <details className="money-rules">
        <summary>How money moves work</summary>
        <div className="notes2">
          <div className="rule"><b>Moving is not spending.</b> Cash going from one of your accounts to another changes two balances and nothing else. Only money leaving the group is an expense.</div>
          <div className="rule"><b>Direction stays consistent.</b> Money leaving A for B reduces “A owes B”. It never creates a new debt the other way.</div>
        </div>
      </details>
    </div>
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

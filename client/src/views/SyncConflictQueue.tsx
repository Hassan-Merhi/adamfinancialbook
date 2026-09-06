import { useState } from 'react';
import { api, type LoadedBook } from '../api';
import { flushOutbox, outbox, snapshot } from '../offline';
import { Card, Empty, money } from '../ui';

export default function SyncConflictQueue({ book, refresh, say }: {
  book: LoadedBook;
  refresh: () => Promise<void>;
  say: (text: string, bad?: boolean) => void;
}) {
  const [busy, setBusy] = useState('');
  const conflicts = outbox.conflicts();
  if (!conflicts.length) return null;

  const rebaseAndSync = async (id: string, patch: { amount?: number; purpose?: string; raw?: string } = {}) => {
    setBusy(id);
    try {
      const fresh = await api.overview();
      await snapshot.save(fresh);
      await outbox.rebase(id, fresh, patch);
      const sent = await flushOutbox((input) => api.addEntry(input));
      await refresh();
      say(sent
        ? `${sent} reviewed offline ${sent === 1 ? 'entry was' : 'entries were'} synced.`
        : 'The conflict was reviewed. Any remaining blocked entry still needs attention.');
    } catch (error) {
      await refresh().catch(() => undefined);
      say((error as Error).message, true);
    } finally {
      setBusy('');
    }
  };

  const editAndRetry = async (id: string, amount: number, purpose: string) => {
    const nextAmountText = window.prompt('Amount to post after reviewing the latest server balance:', String(amount));
    if (nextAmountText === null) return;
    const nextAmount = Number(nextAmountText);
    if (!Number.isFinite(nextAmount) || nextAmount <= 0) {
      say('Enter an amount greater than zero.', true);
      return;
    }
    const nextPurpose = window.prompt('Description / purpose:', purpose) ?? purpose;
    await rebaseAndSync(id, { amount: nextAmount, purpose: nextPurpose, raw: nextPurpose || purpose });
  };

  const discard = async (id: string) => {
    if (!window.confirm('Discard this unsynced offline entry? It has not been posted to the server.')) return;
    setBusy(id);
    try {
      await outbox.drop(id);
      await refresh();
      say('Unsynced offline entry discarded. No server ledger entry was created.');
    } catch (error) {
      say((error as Error).message, true);
    } finally {
      setBusy('');
    }
  };

  return (
    <Card title="Offline sync conflicts" aside={`${conflicts.length} need review`}>
      <div className="note err" role="status">
        These entries were not posted because the server changed while this device was offline. Later dependent entries stay blocked until the first conflict is reviewed.
      </div>
      {!conflicts.length && <Empty>No offline conflicts.</Empty>}
      {conflicts.map(({ item, state }) => {
        const input = item.input;
        const account = input.accountId ? book.accounts.find((candidate) => candidate.id === input.accountId) : null;
        return (
          <div className="attention-row" key={item.id}>
            <div className="attention-copy">
              <b>{input.purpose || input.raw || 'Offline financial entry'}</b>
              <small>
                {[state.conflict?.message, account?.name, input.occurredOn].filter(Boolean).join(' · ')}
              </small>
            </div>
            <strong className="num attention-value">{money(input.amount)}</strong>
            <div className="attention-actions">
              <button
                className="btn small"
                disabled={busy === item.id || !navigator.onLine}
                onClick={() => void rebaseAndSync(item.id)}
              >
                {busy === item.id ? 'Reviewing…' : 'Use latest & retry'}
              </button>
              <button
                className="btn ghost small"
                disabled={busy === item.id || !navigator.onLine}
                onClick={() => void editAndRetry(item.id, input.amount, input.purpose || input.raw)}
              >
                Edit & retry
              </button>
              <button
                className="btn ghost small danger"
                disabled={busy === item.id}
                onClick={() => void discard(item.id)}
              >
                Discard
              </button>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

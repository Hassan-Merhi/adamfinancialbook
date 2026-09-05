/**
 * Say what happened, see what it does, then keep it.
 *
 * The reading always comes back as a draft on screen — every field editable,
 * every consequence shown against the figure it lands on — and nothing reaches
 * the book until the button is pressed.
 */
import { useState } from 'react';
import { api, type LoadedBook, type Reading } from './api';
import { looksOffline, outbox } from './offline';
import { describeEffects, withLoanEffects } from '../../shared/engine';
import type { Draft, SetupDraft } from '../../shared/parse';
import { read as readHere } from '../../shared/parse';
import type { EntryInput, EntryKind, ProjectReceipt } from '../../shared/types';

const money = (v: number) => (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const signed = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const cls = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

const KINDS: Record<EntryKind, string> = {
  expense: 'Expense (paid)',
  credit_purchase: 'Bought on credit — not paid',
  receipt: 'Project receipt',
  transfer: 'Account transfer',
  person_loan: 'Loan to a person',
  salary: 'Salary / advance',
  supplier_payment: 'Supplier payment',
};

const SETUP_LABEL: Record<SetupDraft['kind'], string> = {
  business: 'Business', account: 'Account', project: 'Project',
  payroll: 'Payroll worker', supplier: 'Supplier', lender: 'Person who owes you',
};

const EXAMPLES = [
  '$900 STS chargeuse construction cash',
  '$250 filming for the bikes from construction cash',
  '$12000 withdrawn from the agent into construction cash',
  'move $5,000 from construction cash to STS cash',
  'i bought 1 ton of steel from Dani',
  'add supplier Dani under Construction',
];

export default function Entry({ book, reload, say, onQueued }: {
  book: LoadedBook;
  reload: () => Promise<unknown>;
  say: (text: string, bad?: boolean) => void;
  onQueued?: () => void;
}) {
  const [text, setText] = useState('');
  const [reading, setReading] = useState<Reading | null>(null);
  const [busy, setBusy] = useState(false);

  const readIt = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      setReading(await api.read(text.trim(), new Date().toISOString().slice(0, 10)));
      setText('');
    } catch (e) {
      // With no signal the reader is out of reach, so read it here instead.
      if (looksOffline(e)) {
        setReading({ draft: readHere(text.trim(), book, new Date().toISOString().slice(0, 10)), source: 'rules', duplicate: null });
        setText('');
      } else say((e as Error).message, true);
    }
    finally { setBusy(false); }
  };

  return (
    <div className="entrywrap">
      <div className="card entrycard">
        <div className="entry">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') readIt(); }}
            placeholder="Say what happened —  $900 STS chargeuse construction cash"
          />
          <button className="btn" onClick={readIt} disabled={busy || !text.trim()}>
            {busy ? 'Reading…' : 'Read it'}
          </button>
        </div>
        <div className="examples">
          {EXAMPLES.map((e) => (
            <button key={e} className="ex" onClick={() => setText(e)}>{e}</button>
          ))}
        </div>
      </div>

      {reading && (reading.draft.mode === 'setup'
        ? <SetupCard
            draft={reading.draft}
            book={book}
            done={async (line) => { setReading(null); await reload(); say(line); }}
            cancel={() => setReading(null)}
            fail={(m) => say(m, true)}
          />
        : <EntryCard
            draft={reading.draft}
            duplicate={reading.duplicate}
            source={reading.source}
            book={book}
            done={async (line) => { setReading(null); await reload(); say(line); }}
            cancel={() => setReading(null)}
            fail={(m) => say(m, true)}
            onQueued={onQueued}
          />)}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function EntryCard({ draft, duplicate, source, book, done, cancel, fail, onQueued }: {
  draft: Extract<Draft, { mode: 'entry' }>;
  duplicate: ProjectReceipt | null;
  source: 'claude' | 'rules';
  book: LoadedBook;
  done: (line: string) => void;
  cancel: () => void;
  fail: (m: string) => void;
  onQueued?: () => void;
}) {
  const [input, setInput] = useState<EntryInput>(draft.input);
  const [linked, setLinked] = useState(!!duplicate);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<EntryInput>) => setInput({ ...input, ...patch });

  const withLink: EntryInput = {
    ...input,
    linkReceiptId: linked && duplicate ? duplicate.id : null,
    clientRef: input.clientRef ?? `e_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  };
  const lines = input.amount > 0 ? describeEffects(withLoanEffects(withLink, book), book) : [];

  const needsPerson = input.kind === 'credit_purchase' && !input.personId;
  const needsAccount = input.kind !== 'credit_purchase' && !input.accountId;
  const needsSecond = input.kind === 'transfer' && !input.toAccountId;
  const blocked = !input.amount || needsPerson || needsAccount || needsSecond;

  const save = async () => {
    setBusy(true);
    try {
      const saved = await api.addEntry(withLink);
      const account = book.accounts.find((a) => a.id === input.accountId);
      const toAccount = book.accounts.find((a) => a.id === input.toAccountId);

      if ('mode' in saved && saved.mode === 'pending_transfer') {
        done(`Sent for confirmation — ${money(input.amount)} ${account?.name ?? 'source account'} → ${toAccount?.name ?? 'delegated account'}. It will post only after the recipient confirms receipt.`);
      } else if (input.kind === 'transfer') {
        done(`Moved — ${money(input.amount)} ${account?.name ?? 'source account'} → ${toAccount?.name ?? 'destination account'}.`);
      } else {
        done(`Logged — ${money(input.amount)} ${input.purpose}${account ? `, ${account.name}` : ''}.`);
      }
    } catch (e) {
      if (looksOffline(e)) {
        // No signal: keep it, in order, and send it when there is one.
        outbox.add(withLink);
        onQueued?.();
        done(`Kept — ${money(input.amount)} ${input.purpose}. It will be sent when you are back on a network.`);
      } else fail((e as Error).message);
    }
    finally { setBusy(false); }
  };

  return (
    <div className="review">
      <header>
        <span className="eyebrow">What I heard</span>
        <span className="said">{input.raw}{source === 'rules' ? '' : ' · read by Claude'}</span>
      </header>

      <div className="rgrid">
        <Field label="Type">
          <select value={input.kind} onChange={(e) => {
            const kind = e.target.value as EntryKind;
            set({ kind, accountId: kind === 'credit_purchase' ? null : input.accountId ?? book.accounts[0]?.id ?? null });
          }}>
            {Object.entries(KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>

        <Field label="Amount" flag={!input.amount}>
          <input inputMode="decimal" value={input.amount || ''} placeholder="0"
            onChange={(e) => set({ amount: Number(e.target.value.replace(/[^0-9.]/g, '')) || 0 })} />
        </Field>

        {input.kind === 'credit_purchase'
          ? <Field label="Account"><div className="none">Nothing paid yet</div></Field>
          : <Field label={input.kind === 'transfer' ? 'Out of' : 'Account'}
                   flag={needsAccount} hint={draft.guessed.includes('account') ? 'assumed' : undefined}>
              <select value={input.accountId ?? ''} onChange={(e) => set({ accountId: e.target.value || null })}>
                <option value="">—</option>
                {book.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>}

        {input.kind === 'transfer' && (
          <Field label="Into" flag={needsSecond}>
            <select value={input.toAccountId ?? ''} onChange={(e) => set({ toAccountId: e.target.value || null })}>
              <option value="">—</option>
              {book.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        )}

        <Field label={input.kind === 'credit_purchase' ? 'Owed to' : 'Person'} flag={needsPerson}>
          <select value={input.personId ?? ''} onChange={(e) => set({ personId: e.target.value || null })}>
            <option value="">—</option>
            {book.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>

        <Field label="Project">
          <select value={input.projectId ?? ''} onChange={(e) => set({ projectId: e.target.value || null })}>
            <option value="">—</option>
            {book.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>

        {input.kind !== 'transfer' && (
          <Field label="On behalf of">
            <select value={input.forBusiness ?? ''} onChange={(e) => set({ forBusiness: e.target.value || null })}>
              <option value="">— same business —</option>
              {book.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        )}

        <Field label="Date">
          <input type="date" value={input.occurredOn} onChange={(e) => set({ occurredOn: e.target.value })} />
        </Field>

        <Field label="Purpose" wide>
          <input value={input.purpose} onChange={(e) => set({ purpose: e.target.value })} />
        </Field>
      </div>

      {!input.amount && (
        <div className="warn">
          <b>How much?</b>{' '}
          {draft.quantity ? `"${draft.quantity}" is a quantity, not a price — I won't guess one. ` : ''}
          Put the amount in above.
        </div>
      )}
      {needsPerson && (
        <div className="warn"><b>Who is it owed to?</b> The balance needs a name to sit against.</div>
      )}
      {draft.guessed.includes('account') && input.accountId && (
        <div className="warn">
          <b>I assumed the account.</b> No account was named, so I used{' '}
          {book.accounts.find((a) => a.id === input.accountId)?.name}. Change it if that is wrong.
        </div>
      )}
      {input.kind === 'transfer' && input.accountId && input.toAccountId && (
        <div className="warn">
          <b>Money move.</b> Check the source and destination above. If the destination is controlled by a delegated user,
          this will wait for that person to confirm the cash actually arrived before the ledger changes.
        </div>
      )}
      {duplicate && (
        <>
          <div className="warn">
            <b>Careful.</b> This project already has a {money(duplicate.amount)} receipt recorded
            {duplicate.occurredOn ? ` on ${duplicate.occurredOn}` : ''}. If this is that same money finally
            reaching an account, keep the box ticked — otherwise untick it and it will be recorded as a second receipt.
          </div>
          <label className="check">
            <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} />
            The same money arriving, not new money
          </label>
        </>
      )}

      {lines.length > 0 && (
        <div className="effects">
          {lines.map((l, i) => (
            <div className="eff" key={i}>
              <span className="who">{l.label}</span>
              {l.delta !== null && <span className={`num ${cls(l.delta)}`}>{signed(l.delta)}</span>}
              {l.after !== null && <span className="num muted">→ {l.signed ? money(l.after) : money(l.after)}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="ractions">
        <button className="btn" onClick={save} disabled={blocked || busy}>
          {busy ? 'Saving…' : input.kind === 'transfer' ? 'Move it' : 'Log it'}
        </button>
        <button className="btn ghost" onClick={cancel}>Discard</button>
        <label className="check" style={{ marginLeft: 'auto' }}>
          <input type="checkbox" checked={!!input.historical}
            onChange={(e) => set({ historical: e.target.checked })} />
          Historical — don't touch today's cash
        </label>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SetupCard({ draft, book, done, cancel, fail }: {
  draft: SetupDraft;
  book: LoadedBook;
  done: (line: string) => void;
  cancel: () => void;
  fail: (m: string) => void;
}) {
  const [kind, setKind] = useState(draft.kind);
  const [name, setName] = useState(draft.name);
  const [businessId, setBusinessId] = useState(draft.businessId ?? book.businesses[0]?.id ?? '');
  const [amount, setAmount] = useState(draft.amount);
  const [busy, setBusy] = useState(false);

  const amountLabel = kind === 'payroll' ? 'Monthly salary'
    : kind === 'supplier' ? 'Opening amount you owe'
    : kind === 'lender' ? 'Opening amount owed to you'
    : kind === 'project' ? 'Received before the cut-off'
    : 'Opening balance';

  const preview = kind === 'business'
    ? `A new business "${name || '—'}", with its own accounts and its own loan positions.`
    : kind === 'account' ? `A cash account "${name || '—'}" under ${book.businesses.find((b) => b.id === businessId)?.name}, starting at ${money(amount)}. Selectable on every entry from now on.`
    : kind === 'project' ? `A project "${name || '—'}", ${money(amount)} received before the cut-off.`
    : kind === 'payroll' ? `"${name || '—'}" on payroll, salary ${money(amount)}, nothing taken yet.`
    : kind === 'supplier' ? `Supplier "${name || '—'}", you owe ${money(-amount)} to start.`
    : `"${name || '—'}" owes you ${money(amount)}.`;

  const save = async () => {
    setBusy(true);
    try {
      if (kind === 'business') await api.addBusiness(name);
      else if (kind === 'account') await api.addAccount({ name, businessId, opening: amount });
      else if (kind === 'project') await api.addProject({ name, businessId, opening: amount });
      else {
        await api.addPerson({
          name, businessId,
          kind: kind === 'payroll' ? 'salary' : kind === 'supplier' ? 'payable' : 'receivable',
          role: kind === 'payroll' ? 'Staff' : kind === 'supplier' ? 'Supplier' : 'Personal loan',
          opening: kind === 'payroll' ? 0 : amount,
          salary: kind === 'payroll' ? amount : 0,
        });
      }
      done(`Created — ${SETUP_LABEL[kind]} "${name}". You can name it in a sentence from now on.`);
    } catch (e) { fail((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="review">
      <header>
        <span className="eyebrow">Setting up the book</span>
        <span className="said">{draft.raw}</span>
      </header>
      <div className="rgrid">
        <Field label="Create">
          <select value={kind} onChange={(e) => setKind(e.target.value as SetupDraft['kind'])}>
            {Object.entries(SETUP_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Name" flag={!name}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What to call it" />
        </Field>
        {kind !== 'business' && (
          <Field label="Under">
            <select value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
              {book.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        )}
        <Field label={amountLabel}>
          <input inputMode="decimal" value={amount || ''} placeholder="0"
            onChange={(e) => setAmount(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)} />
        </Field>
      </div>
      {!name && <div className="warn"><b>What is it called?</b> Give it a name and it gets created.</div>}
      <div className="effects"><div className="eff"><span className="who">{preview}</span></div></div>
      <div className="ractions">
        <button className="btn" onClick={save} disabled={!name || busy}>{busy ? 'Creating…' : 'Create it'}</button>
        <button className="btn ghost" onClick={cancel}>Discard</button>
      </div>
    </div>
  );
}

function Field({ label, children, flag, hint, wide }: {
  label: string; children: React.ReactNode; flag?: boolean; hint?: string; wide?: boolean;
}) {
  return (
    <div className={`f${flag ? ' needed' : ''}${wide ? ' wide' : ''}`}>
      <label>{label}{hint ? <span className="hint"> · {hint}</span> : null}</label>
      {children}
    </div>
  );
}

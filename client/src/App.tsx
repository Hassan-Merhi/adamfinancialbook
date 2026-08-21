/**
 * Phase 1's screen: plain forms over the real book.
 *
 * It is deliberately unglamorous — entry by sentence and the finished screens
 * are Phase 2 and 3. What matters here is that every figure below is computed
 * from opening balances plus effects, straight out of the database.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, type LoadedBook } from './api';
import type { EntryKind } from '../../shared/types';

const money = (v: number) => (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const sign = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const today = () => new Date().toISOString().slice(0, 10);

const KINDS: Record<EntryKind, string> = {
  expense: 'Expense (paid)',
  credit_purchase: 'Bought on credit — not paid',
  receipt: 'Project receipt',
  transfer: 'Account transfer',
  person_loan: 'Loan to a person',
  salary: 'Salary / advance',
  supplier_payment: 'Supplier payment',
};

export default function App() {
  const [book, setBook] = useState<LoadedBook | null>(null);
  const [tab, setTab] = useState<'book' | 'setup'>('book');
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);

  const reload = () => api.book().then(setBook).catch((e) => setNote({ text: e.message, bad: true }));
  useEffect(() => { reload(); }, []);

  const run = async (work: () => Promise<unknown>, done: string) => {
    try { await work(); await reload(); setNote({ text: done }); }
    catch (e) { setNote({ text: (e as Error).message, bad: true }); }
  };

  if (!book) {
    return <div className="wrap"><p className="muted">Opening the book…</p>
      {note && <div className={`note ${note.bad ? 'err' : ''}`}>{note.text}</div>}</div>;
  }

  const empty = book.businesses.length === 0;

  return (
    <div className="wrap">
      <div className="top">
        <div>
          <h1>Financial Book</h1>
          <p className="muted" style={{ margin: '2px 0 0' }}>
            Minus means you owe it. Plus means it is owed to you.
          </p>
        </div>
        <div className="cash">
          <small>Cash on hand</small>
          <b className="num">{money(book.balances.totalCash)}</b>
        </div>
      </div>

      <div className="tabs">
        <button className="tab" aria-pressed={tab === 'book'} onClick={() => setTab('book')}>The book</button>
        <button className="tab" aria-pressed={tab === 'setup'} onClick={() => setTab('setup')}>Set it up</button>
      </div>

      {note && <div className={`note ${note.bad ? 'err' : 'ok'}`}>{note.text}</div>}

      {empty && (
        <div className="note">
          The book is empty. Open <b>Set it up</b> and add a business, then its accounts —
          opening balances go in as you create each one.
        </div>
      )}

      {tab === 'setup' ? <Setup book={book} run={run} /> : <TheBook book={book} run={run} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TheBook({ book, run }: { book: LoadedBook; run: (w: () => Promise<unknown>, d: string) => void }) {
  const owed = book.people.filter((p) => book.balances.people[p.id] > 0);
  const owing = book.people.filter((p) => book.balances.people[p.id] < 0);
  const entries = [...book.entries].reverse();

  return (
    <>
      <NewEntry book={book} run={run} />

      {book.businesses.map((b) => (
        <div className="card" key={b.id}>
          <h3><span>{b.name}</span><span className="num">{money(book.balances.businesses[b.id] ?? 0)}</span></h3>
          {book.accounts.filter((a) => a.businessId === b.id).map((a) => (
            <div className="row" key={a.id}>
              <span>{a.name}<small>cash account</small></span>
              <span className="num">{money(book.balances.accounts[a.id] ?? 0)}</span>
            </div>
          ))}
          {book.loans
            .filter((l) => (l.fromBusiness === b.id || l.toBusiness === b.id) && (book.balances.loans[l.id] ?? 0) !== 0)
            .map((l) => {
              const raw = book.balances.loans[l.id] ?? 0;
              const v = l.fromBusiness === b.id ? -raw : raw;   // read from this business's side
              const other = book.businesses.find((x) => x.id === (l.fromBusiness === b.id ? l.toBusiness : l.fromBusiness));
              return (
                <div className="row" key={l.id}>
                  <span>{v < 0 ? 'Owes ' : 'Owed by '}{other?.name}
                    <small>{v < 0 ? 'must be returned' : 'waiting on it'}</small></span>
                  <span className={`num ${sign(v)}`}>{money(v)}</span>
                </div>
              );
            })}
        </div>
      ))}

      {book.projects.length > 0 && (
        <div className="card">
          <h3>Projects <span className="muted">received to date</span></h3>
          {book.projects.map((p) => (
            <div className="row" key={p.id}>
              <span>{p.name}<small>{p.scope || 'project'}</small></span>
              <span className="num">{money(book.balances.projects[p.id] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}

      {(owed.length > 0 || owing.length > 0) && (
        <div className="card">
          <h3>People</h3>
          {[...owed, ...owing].map((p) => (
            <div className="row" key={p.id}>
              <span>{p.name}<small>{p.role || p.kind}</small></span>
              <span className={`num ${sign(book.balances.people[p.id] ?? 0)}`}>{money(book.balances.people[p.id] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h3><span>Entries</span><span className="muted">{book.entries.length} logged</span></h3>
        {entries.length === 0 && <div className="row muted">Nothing logged yet.</div>}
        {entries.slice(0, 40).map((e) => (
          <div className="row" key={e.id}>
            <span>
              {e.purpose || KINDS[e.kind]}
              <small>
                {e.occurredOn} · {KINDS[e.kind]}
                {e.correctedFrom != null && ` · corrected, was ${money(e.correctedFrom)}`}
              </small>
            </span>
            <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span className="num">{money(e.amount)}</span>
              <button
                className="btn ghost small"
                onClick={() => {
                  const next = prompt(`Correct the amount for "${e.purpose}"`, String(e.amount));
                  const amount = Number(next);
                  if (next && amount > 0 && amount !== e.amount) run(() => api.correct(e.id, amount), 'Corrected.');
                }}
              >Correct</button>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

function NewEntry({ book, run }: { book: LoadedBook; run: (w: () => Promise<unknown>, d: string) => void }) {
  const [kind, setKind] = useState<EntryKind>('expense');
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [occurredOn, setOccurredOn] = useState(today());
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [personId, setPersonId] = useState('');
  const [forBusiness, setForBusiness] = useState('');

  const needsAccount = kind !== 'credit_purchase';
  const needsPerson = ['credit_purchase', 'person_loan', 'salary', 'supplier_payment'].includes(kind);
  const ready = Number(amount) > 0 && (!needsAccount || accountId) && (!needsPerson || personId)
    && (kind !== 'transfer' || toAccountId);

  const people = useMemo(() => book.people.filter((p) =>
    kind === 'credit_purchase' || kind === 'supplier_payment' ? p.kind === 'payable'
    : kind === 'salary' ? p.kind === 'salary'
    : kind === 'person_loan' ? p.kind === 'receivable' : true), [book.people, kind]);

  if (book.accounts.length === 0) return null;

  return (
    <div className="card">
      <h3>Log something</h3>
      <div className="form">
        <div className="f"><label>Type</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as EntryKind)}>
            {Object.entries(KINDS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select></div>
        <div className="f"><label>Amount</label>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" /></div>
        <div className="f"><label>Date</label>
          <input type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} /></div>
        {needsAccount && (
          <div className="f"><label>{kind === 'transfer' ? 'Out of' : 'Account'}</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">—</option>
              {book.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></div>
        )}
        {kind === 'transfer' && (
          <div className="f"><label>Into</label>
            <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
              <option value="">—</option>
              {book.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></div>
        )}
        {needsPerson && (
          <div className="f"><label>{kind === 'credit_purchase' ? 'Owed to' : 'Person'}</label>
            <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
              <option value="">—</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></div>
        )}
        <div className="f"><label>Project</label>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">—</option>
            {book.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></div>
        {kind !== 'transfer' && (
          <div className="f"><label>On behalf of</label>
            <select value={forBusiness} onChange={(e) => setForBusiness(e.target.value)}>
              <option value="">— same business —</option>
              {book.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select></div>
        )}
        <div className="f" style={{ flex: 2 }}><label>Purpose</label>
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="What it was for" /></div>
        <button className="btn" disabled={!ready} onClick={() => {
          run(() => api.addEntry({
            occurredOn, kind, amount: Number(amount), purpose, raw: '',
            accountId: accountId || null, toAccountId: toAccountId || null,
            projectId: projectId || null, personId: personId || null,
            forBusiness: forBusiness || null, historical: false, linkReceiptId: null,
          }), 'Logged.');
          setAmount(''); setPurpose('');
        }}>Log it</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Setup({ book, run }: { book: LoadedBook; run: (w: () => Promise<unknown>, d: string) => void }) {
  const [biz, setBiz] = useState('');
  const [acc, setAcc] = useState({ name: '', businessId: '', opening: '' });
  const [prj, setPrj] = useState({ name: '', businessId: '', opening: '' });
  const [per, setPer] = useState({ name: '', businessId: '', kind: 'payable', role: '', opening: '', salary: '' });
  const [loan, setLoan] = useState({ fromBusiness: '', toBusiness: '', opening: '' });
  const first = book.businesses[0]?.id ?? '';

  return (
    <>
      <div className="note">
        Opening balances go in here, once. Everything that happened before your cut-off date
        becomes a single opening figure per account — there is no history to re-enter.
      </div>

      <div className="card">
        <h3>Businesses</h3>
        {book.businesses.map((b) => <div className="row" key={b.id}><span>{b.name}</span>
          <span className="num">{money(book.balances.businesses[b.id] ?? 0)}</span></div>)}
        <div className="form">
          <div className="f"><label>Name</label>
            <input value={biz} onChange={(e) => setBiz(e.target.value)} placeholder="Construction" /></div>
          <button className="btn" disabled={!biz.trim()}
            onClick={() => { run(() => api.addBusiness(biz.trim()), 'Business created.'); setBiz(''); }}>Add</button>
        </div>
      </div>

      <div className="card">
        <h3>Accounts</h3>
        {book.accounts.map((a) => <div className="row" key={a.id}>
          <span>{a.name}<small>{book.businesses.find((b) => b.id === a.businessId)?.name}</small></span>
          <span className="num">{money(book.balances.accounts[a.id] ?? 0)}</span></div>)}
        <div className="form">
          <div className="f"><label>Name</label>
            <input value={acc.name} onChange={(e) => setAcc({ ...acc, name: e.target.value })} placeholder="Soficom" /></div>
          <div className="f"><label>Under</label>
            <select value={acc.businessId || first} onChange={(e) => setAcc({ ...acc, businessId: e.target.value })}>
              {book.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select></div>
          <div className="f"><label>Opening balance</label>
            <input inputMode="decimal" value={acc.opening} onChange={(e) => setAcc({ ...acc, opening: e.target.value })} placeholder="0" /></div>
          <button className="btn" disabled={!acc.name.trim() || !book.businesses.length}
            onClick={() => {
              run(() => api.addAccount({ name: acc.name.trim(), businessId: acc.businessId || first, opening: Number(acc.opening) || 0 }), 'Account created.');
              setAcc({ name: '', businessId: '', opening: '' });
            }}>Add</button>
        </div>
      </div>

      <div className="card">
        <h3>Projects</h3>
        {book.projects.map((p) => <div className="row" key={p.id}>
          <span>{p.name}<small>{book.businesses.find((b) => b.id === p.businessId)?.name}</small></span>
          <span className="num">{money(book.balances.projects[p.id] ?? 0)}</span></div>)}
        <div className="form">
          <div className="f"><label>Name</label>
            <input value={prj.name} onChange={(e) => setPrj({ ...prj, name: e.target.value })} placeholder="Kin Severe" /></div>
          <div className="f"><label>Under</label>
            <select value={prj.businessId || first} onChange={(e) => setPrj({ ...prj, businessId: e.target.value })}>
              {book.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select></div>
          <div className="f"><label>Received before the cut-off</label>
            <input inputMode="decimal" value={prj.opening} onChange={(e) => setPrj({ ...prj, opening: e.target.value })} placeholder="0" /></div>
          <button className="btn" disabled={!prj.name.trim() || !book.businesses.length}
            onClick={() => {
              run(() => api.addProject({ name: prj.name.trim(), businessId: prj.businessId || first, opening: Number(prj.opening) || 0 }), 'Project created.');
              setPrj({ name: '', businessId: '', opening: '' });
            }}>Add</button>
        </div>
      </div>

      <div className="card">
        <h3>People <span className="muted">owe you · payroll · suppliers</span></h3>
        {book.people.map((p) => <div className="row" key={p.id}>
          <span>{p.name}<small>{p.role || p.kind}</small></span>
          <span className={`num ${sign(book.balances.people[p.id] ?? 0)}`}>{money(book.balances.people[p.id] ?? 0)}</span></div>)}
        <div className="form">
          <div className="f"><label>Name</label>
            <input value={per.name} onChange={(e) => setPer({ ...per, name: e.target.value })} placeholder="Dani" /></div>
          <div className="f"><label>Kind</label>
            <select value={per.kind} onChange={(e) => setPer({ ...per, kind: e.target.value })}>
              <option value="payable">Supplier — you owe them</option>
              <option value="salary">Payroll</option>
              <option value="receivable">Owes you</option>
            </select></div>
          <div className="f"><label>Under</label>
            <select value={per.businessId || first} onChange={(e) => setPer({ ...per, businessId: e.target.value })}>
              {book.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select></div>
          <div className="f"><label>{per.kind === 'salary' ? 'Monthly salary' : 'Opening amount'}</label>
            <input inputMode="decimal"
              value={per.kind === 'salary' ? per.salary : per.opening}
              onChange={(e) => setPer(per.kind === 'salary' ? { ...per, salary: e.target.value } : { ...per, opening: e.target.value })}
              placeholder="0" /></div>
          <button className="btn" disabled={!per.name.trim() || !book.businesses.length}
            onClick={() => {
              run(() => api.addPerson({
                name: per.name.trim(), businessId: per.businessId || first, kind: per.kind,
                role: per.role || (per.kind === 'payable' ? 'Supplier' : per.kind === 'salary' ? 'Staff' : 'Personal loan'),
                opening: Number(per.opening) || 0, salary: Number(per.salary) || 0,
              }), 'Person created.');
              setPer({ name: '', businessId: '', kind: per.kind, role: '', opening: '', salary: '' });
            }}>Add</button>
        </div>
      </div>

      {book.businesses.length > 1 && (
        <div className="card">
          <h3>Opening positions between businesses</h3>
          <div className="form">
            <div className="f"><label>This business</label>
              <select value={loan.fromBusiness || first} onChange={(e) => setLoan({ ...loan, fromBusiness: e.target.value })}>
                {book.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select></div>
            <div className="f"><label>Owes this one</label>
              <select value={loan.toBusiness} onChange={(e) => setLoan({ ...loan, toBusiness: e.target.value })}>
                <option value="">—</option>
                {book.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select></div>
            <div className="f"><label>Amount</label>
              <input inputMode="decimal" value={loan.opening} onChange={(e) => setLoan({ ...loan, opening: e.target.value })} placeholder="0" /></div>
            <button className="btn" disabled={!loan.toBusiness || loan.toBusiness === (loan.fromBusiness || first)}
              onClick={() => {
                run(() => api.setLoan({
                  fromBusiness: loan.fromBusiness || first, toBusiness: loan.toBusiness, opening: Number(loan.opening) || 0,
                }), 'Position set.');
                setLoan({ fromBusiness: '', toBusiness: '', opening: '' });
              }}>Set</button>
          </div>
        </div>
      )}
    </>
  );
}

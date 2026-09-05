/** Opening balances, organization setup, and owner-only book reset. */
import { useState } from 'react';
import { api, type LoadedBook } from '../api';
import { money, tone } from '../ui';
import OperationsPanel from './OperationsPanel';
import ResetData from './ResetData';

export default function Setup({ book, run }: { book: LoadedBook; run: (w: () => Promise<unknown>, d: string) => void }) {
  const [biz, setBiz] = useState('');
  const [acc, setAcc] = useState({ name: '', businessId: '', opening: '' });
  const [prj, setPrj] = useState({ name: '', businessId: '', opening: '' });
  const [per, setPer] = useState({ name: '', businessId: '', kind: 'payable', role: '', opening: '', salary: '' });
  const [loan, setLoan] = useState({ fromBusiness: '', toBusiness: '', opening: '' });
  const [rem, setRem] = useState({ what: '', amount: '', accountId: '' });
  const first = book.businesses[0]?.id ?? '';

  return (
    <section className="setup-page">
      <div className="dhead setup-head">
        <div>
          <h2>Setup</h2>
          <p className="muted">Create the structure of the book, set opening figures, and manage data safely.</p>
        </div>
        <div className="setup-counts" aria-label="Setup summary">
          <span><b>{book.businesses.length}</b> businesses</span>
          <span><b>{book.accounts.length}</b> accounts</span>
        </div>
      </div>

      <div className="note setup-intro">
        Opening balances are entered once. Past activity before your cut-off belongs in the opening figure, not as hundreds of old transactions.
      </div>

      <div className="card setup-card" id="setup-businesses">
        <h3>Businesses <span className="muted">organization</span></h3>
        <div className="setup-existing">
          {book.businesses.map((b) => <div className="row" key={b.id}><span className="main"><b>{b.name}</b></span><span className="val num">{money(book.balances.businesses[b.id] ?? 0)}</span></div>)}
        </div>
        <div className="form setup-form">
          <div className="f"><label>Name</label><input value={biz} onChange={(e) => setBiz(e.target.value)} placeholder="Construction" /></div>
          <button className="btn" disabled={!biz.trim()} onClick={() => { run(() => api.addBusiness(biz.trim()), 'Business created.'); setBiz(''); }}>Add business</button>
        </div>
      </div>

      <div className="card setup-card" id="setup-accounts">
        <h3>Accounts <span className="muted">money</span></h3>
        <div className="setup-existing">
          {book.accounts.map((a) => <div className="row" key={a.id}>
            <span className="main"><b>{a.name}</b>{a.businessId && <small>{book.businesses.find((b) => b.id === a.businessId)?.name}</small>}</span>
            <span className="val num">{money(book.balances.accounts[a.id] ?? 0)}</span>
          </div>)}
        </div>
        <div className="form setup-form">
          <div className="f"><label>Name</label><input value={acc.name} onChange={(e) => setAcc({ ...acc, name: e.target.value })} placeholder="Cash / bank / wallet" /></div>
          <div className="f"><label>Opening balance</label><input inputMode="decimal" value={acc.opening} onChange={(e) => setAcc({ ...acc, opening: e.target.value })} placeholder="0" /></div>
          <button className="btn" disabled={!acc.name.trim()} onClick={() => {
            run(() => api.addAccount({ name: acc.name.trim(), businessId: null, opening: Number(acc.opening) || 0 }), 'Account created.');
            setAcc({ name: '', businessId: '', opening: '' });
          }}>Add account</button>
        </div>
      </div>

      <div className="card setup-card" id="setup-projects">
        <h3>Projects <span className="muted">jobs</span></h3>
        <div className="setup-existing">
          {book.projects.map((p) => <div className="row" key={p.id}>
            <span className="main"><b>{p.name}</b><small>{book.businesses.find((b) => b.id === p.businessId)?.name}</small></span>
            <span className="val num">{money(book.balances.projects[p.id] ?? 0)}</span>
          </div>)}
        </div>
        <div className="form setup-form">
          <div className="f"><label>Name</label><input value={prj.name} onChange={(e) => setPrj({ ...prj, name: e.target.value })} placeholder="Kin Severe" /></div>
          <div className="f"><label>Business</label><select value={prj.businessId || first} onChange={(e) => setPrj({ ...prj, businessId: e.target.value })}>{book.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
          <div className="f"><label>Received before cut-off</label><input inputMode="decimal" value={prj.opening} onChange={(e) => setPrj({ ...prj, opening: e.target.value })} placeholder="0" /></div>
          <button className="btn" disabled={!prj.name.trim() || !book.businesses.length} onClick={() => {
            run(() => api.addProject({ name: prj.name.trim(), businessId: prj.businessId || first, opening: Number(prj.opening) || 0 }), 'Project created.');
            setPrj({ name: '', businessId: '', opening: '' });
          }}>Add project</button>
        </div>
      </div>

      <div className="card setup-card" id="setup-people">
        <h3>People <span className="muted">loans · payroll · suppliers</span></h3>
        <div className="setup-existing">
          {book.people.map((p) => <div className="row" key={p.id}>
            <span className="main"><b>{p.name}</b><small>{p.role || p.kind}</small></span>
            <span className={`val num ${tone(book.balances.people[p.id] ?? 0)}`}>{money(book.balances.people[p.id] ?? 0)}</span>
          </div>)}
        </div>
        <div className="form setup-form">
          <div className="f"><label>Name</label><input value={per.name} onChange={(e) => setPer({ ...per, name: e.target.value })} placeholder="Dani" /></div>
          <div className="f"><label>Kind</label><select value={per.kind} onChange={(e) => setPer({ ...per, kind: e.target.value })}><option value="payable">Supplier — you owe them</option><option value="salary">Payroll</option><option value="receivable">Owes you</option></select></div>
          <div className="f"><label>Business</label><select value={per.businessId || first} onChange={(e) => setPer({ ...per, businessId: e.target.value })}>{book.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
          <div className="f"><label>{per.kind === 'salary' ? 'Monthly salary' : 'Opening amount'}</label><input inputMode="decimal" value={per.kind === 'salary' ? per.salary : per.opening} onChange={(e) => setPer(per.kind === 'salary' ? { ...per, salary: e.target.value } : { ...per, opening: e.target.value })} placeholder="0" /></div>
          <button className="btn" disabled={!per.name.trim() || !book.businesses.length} onClick={() => {
            run(() => api.addPerson({ name: per.name.trim(), businessId: per.businessId || first, kind: per.kind, role: per.role || (per.kind === 'payable' ? 'Supplier' : per.kind === 'salary' ? 'Staff' : 'Personal loan'), opening: Number(per.opening) || 0, salary: Number(per.salary) || 0 }), 'Person created.');
            setPer({ name: '', businessId: '', kind: per.kind, role: '', opening: '', salary: '' });
          }}>Add person</button>
        </div>
      </div>

      <div className="card setup-card" id="setup-reminders">
        <h3>Reminders <span className="muted">spoken for, not yet paid</span></h3>
        <div className="setup-existing">
          {book.reminders.map((r) => <div className="row" key={r.id}>
            <span className="main"><b>{r.what}</b><small>{[book.accounts.find((a) => a.id === r.accountId)?.name, r.note].filter(Boolean).join(' · ')}</small></span>
            <span className="val num">{money(r.amount)}<small><button className="linkbtn" onClick={() => run(() => api.clearReminder(r.id), 'Reminder cleared.')}>clear</button></small></span>
          </div>)}
        </div>
        <div className="form setup-form">
          <div className="f"><label>What</label><input value={rem.what} onChange={(e) => setRem({ ...rem, what: e.target.value })} placeholder="Transport for the Depot container" /></div>
          <div className="f"><label>Amount</label><input inputMode="decimal" value={rem.amount} onChange={(e) => setRem({ ...rem, amount: e.target.value })} placeholder="0" /></div>
          <div className="f"><label>Account</label><select value={rem.accountId} onChange={(e) => setRem({ ...rem, accountId: e.target.value })}><option value="">Not decided</option>{book.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <button className="btn" disabled={!rem.what.trim()} onClick={() => {
            run(() => api.addReminder({ what: rem.what.trim(), amount: Number(rem.amount) || 0, accountId: rem.accountId || null }), 'Reminder kept.');
            setRem({ what: '', amount: '', accountId: '' });
          }}>Add reminder</button>
        </div>
      </div>

      {book.businesses.length > 1 && (
        <div className="card setup-card" id="setup-openings">
          <h3>Opening positions <span className="muted">between businesses</span></h3>
          <div className="form setup-form">
            <div className="f"><label>This business</label><select value={loan.fromBusiness || first} onChange={(e) => setLoan({ ...loan, fromBusiness: e.target.value })}>{book.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
            <div className="f"><label>Owes</label><select value={loan.toBusiness} onChange={(e) => setLoan({ ...loan, toBusiness: e.target.value })}><option value="">Choose business</option>{book.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
            <div className="f"><label>Amount</label><input inputMode="decimal" value={loan.opening} onChange={(e) => setLoan({ ...loan, opening: e.target.value })} placeholder="0" /></div>
            <button className="btn" disabled={!loan.toBusiness || loan.toBusiness === (loan.fromBusiness || first)} onClick={() => {
              run(() => api.setLoan({ fromBusiness: loan.fromBusiness || first, toBusiness: loan.toBusiness, opening: Number(loan.opening) || 0 }), 'Position set.');
              setLoan({ fromBusiness: '', toBusiness: '', opening: '' });
            }}>Set position</button>
          </div>
        </div>
      )}

      <OperationsPanel />
      <ResetData />
    </section>
  );
}

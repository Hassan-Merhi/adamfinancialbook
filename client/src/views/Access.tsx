/**
 * Who can open the book.
 *
 * Your own password at the top, because that is the thing you change most; the
 * people you have given keys to underneath, because that is the thing you check
 * most.
 */
import { useEffect, useState } from 'react';
import {
  api,
  type DelegationAccount,
  type DelegationDelegate,
  type Keyholder,
  type Me,
} from '../api';
import { Card, Empty } from '../ui';
import './Access.css';

export default function Access({ me, say }: {
  me: NonNullable<Me['user']>;
  say: (text: string, bad?: boolean) => void;
}) {
  const [people, setPeople] = useState<Keyholder[] | null>(null);
  const [accounts, setAccounts] = useState<DelegationAccount[]>([]);
  const [delegates, setDelegates] = useState<DelegationDelegate[]>([]);
  const [suggestion, setSuggestion] = useState('');
  const owner = me.role === 'owner';

  const reload = () => {
    if (!owner) return;
    Promise.all([api.users(), api.evidenceDashboard()])
      .then(([users, dashboard]) => {
        setPeople(users.users);
        setSuggestion(users.suggestion);
        setAccounts(dashboard.mode === 'owner' ? dashboard.accounts ?? [] : []);
        setDelegates(dashboard.mode === 'owner' ? dashboard.delegates ?? [] : []);
      })
      .catch((e) => say((e as Error).message, true));
  };
  useEffect(reload, []);

  return (
    <>
      <p className="lede">
        Nobody can let themselves in. People open the book with an email and password you give
        them here, and you can take it back at any time.
      </p>

      <OwnPassword say={say} />

      {owner && (
        <>
          <Card title="Who can open the book" aside={people ? `${people.length}` : undefined}>
            {!people && <Empty>Reading…</Empty>}
            {people?.map((p) => (
              <Person
                key={p.id}
                person={p}
                me={me}
                say={say}
                reload={reload}
                accounts={accounts}
                delegates={delegates}
              />
            ))}
          </Card>

          <AddPerson suggestion={suggestion} say={say} reload={reload} />
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

function OwnPassword({ say }: { say: (t: string, bad?: boolean) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);

  const mismatch = again.length > 0 && next !== again;
  const ready = current && next.length >= 8 && next === again && !busy;

  const go = async () => {
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent(''); setNext(''); setAgain('');
      say('Password changed. Anywhere else you were signed in has been signed out.');
    } catch (e) { say((e as Error).message, true); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Your password">
      <div className="form">
        <div className="f">
          <label>Current</label>
          <input type="password" autoComplete="current-password" value={current}
            onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="f">
          <label>New</label>
          <input type="password" autoComplete="new-password" value={next}
            onChange={(e) => setNext(e.target.value)} placeholder="at least 8 characters" />
        </div>
        <div className={`f${mismatch ? ' needed' : ''}`}>
          <label>New again</label>
          <input type="password" autoComplete="new-password" value={again}
            onChange={(e) => setAgain(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ready && go()} />
        </div>
        <button className="btn" disabled={!ready} onClick={go}>{busy ? 'Changing…' : 'Change it'}</button>
      </div>
      {mismatch && <div className="warn">Those two do not match.</div>}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function Person({ person, me, say, reload, accounts, delegates }: {
  person: Keyholder;
  me: NonNullable<Me['user']>;
  say: (t: string, bad?: boolean) => void;
  reload: () => void;
  accounts: DelegationAccount[];
  delegates: DelegationDelegate[];
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const isYou = person.id === me.id;

  const run = async (work: () => Promise<unknown>, done: string) => {
    try { await work(); reload(); say(done); }
    catch (e) { say((e as Error).message, true); }
  };

  return (
    <div className={`person${open ? ' open' : ''}`}>
      <button className="row link" onClick={() => setOpen(!open)}>
        <span className="face">{person.email.slice(0, 1).toUpperCase()}</span>
        <span className="main">
          <b>{person.email}{isYou && <span className="you">you</span>}</b>
          <small>{person.lastSeen ? `last opened it ${when(person.lastSeen)}` : 'has not opened it yet'}</small>
        </span>
        <span className={`chip ${person.role}`}>{person.role === 'owner' ? 'Owner' : 'Entry only'}</span>
        <span className="chev">›</span>
      </button>

      {open && (
        <div className="personmore">
          {person.role === 'entry' && (
            <AccountAccess
              person={person}
              accounts={accounts}
              delegates={delegates}
              say={say}
              reload={reload}
            />
          )}

          <div className="form">
            <div className="f">
              <label>Set a new password for them</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="at least 8 characters" />
            </div>
            <button className="btn" disabled={password.length < 8}
              onClick={() => { run(() => api.resetPassword(person.id, password), `New password set for ${person.email}. Tell it to them.`); setPassword(''); }}>
              Set it
            </button>
          </div>
          <div className="personactions">
            <button className="btn ghost small"
              onClick={() => run(() => api.setRole(person.id, person.role === 'owner' ? 'entry' : 'owner'),
                person.role === 'owner' ? `${person.email} can now only add entries.` : `${person.email} is now an owner.`)}>
              {person.role === 'owner' ? 'Make entry-only' : 'Make an owner'}
            </button>
            {!isYou && (
              <button className="btn ghost small danger"
                onClick={() => { if (confirm(`Take away ${person.email}'s access? They will be signed out at once.`)) run(() => api.removeUser(person.id), `${person.email} can no longer open the book.`); }}>
                Take away access
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AccountAccess({ person, accounts, delegates, say, reload }: {
  person: Keyholder;
  accounts: DelegationAccount[];
  delegates: DelegationDelegate[];
  say: (t: string, bad?: boolean) => void;
  reload: () => void;
}) {
  const assigned = delegates.find((d) => d.id === person.id)?.accountIds ?? [];
  const assignedKey = [...assigned].sort().join('|');
  const [selected, setSelected] = useState<string[]>(assigned);
  const [busy, setBusy] = useState(false);

  useEffect(() => setSelected(assigned), [person.id, assignedKey]);

  const selectedKey = [...selected].sort().join('|');
  const dirty = selectedKey !== assignedKey;

  const holder = (accountId: string) =>
    delegates.find((d) => d.id !== person.id && d.accountIds.includes(accountId));

  const toggle = (accountId: string, checked: boolean) => {
    setSelected((current) => checked
      ? [...new Set([...current, accountId])]
      : current.filter((id) => id !== accountId));
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.setUserAccounts(person.id, selected);
      reload();
      say(selected.length
        ? `${person.email} can now spend from ${selected.length} assigned account${selected.length === 1 ? '' : 's'}.`
        : `${person.email} no longer has access to any spending account.`);
    } catch (e) { say((e as Error).message, true); }
    finally { setBusy(false); }
  };

  return (
    <section className="accountaccess" aria-label={`Account access for ${person.email}`}>
      <div className="accountaccesshead">
        <div>
          <b>Accounts they can use</b>
          <small>Select the cash accounts this person may spend from in the prompt.</small>
        </div>
        <span className="chip">{selected.length} selected</span>
      </div>

      {accounts.length === 0 ? (
        <div className="accountaccessempty">No accounts exist yet.</div>
      ) : (
        <div className="accountaccesslist">
          {accounts.map((account) => {
            const taken = holder(account.id);
            const checked = selected.includes(account.id);
            return (
              <label className={`accountaccessrow${taken ? ' disabled' : ''}`} key={account.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!!taken || busy}
                  onChange={(e) => toggle(account.id, e.target.checked)}
                />
                <span className="accountaccessmain">
                  <b>{account.name}</b>
                  <small>{taken ? `Already assigned to ${taken.email}` : 'Available for this user'}</small>
                </span>
                <span className="num">{money(account.balance)}</span>
              </label>
            );
          })}
        </div>
      )}

      <div className="accountaccessactions">
        <span className="muted small">Changes only affect this user's transaction access.</span>
        <button className="btn small" disabled={!dirty || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save account access'}
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function AddPerson({ suggestion, say, reload }: {
  suggestion: string;
  say: (t: string, bad?: boolean) => void;
  reload: () => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('entry');
  const [password, setPassword] = useState('');
  const [made, setMade] = useState<{ email: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    try {
      await api.addUser({ email, password, role });
      setMade({ email, password });
      setEmail(''); setPassword('');
      reload();
    } catch (e) { say((e as Error).message, true); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Give someone access">
      {made && (
        <div className="handover">
          <b>{made.email} can now open the book.</b>
          <span>Their password is <code>{made.password}</code> — tell it to them, and have them
            change it on this screen. It will not be shown again.</span>
          <button className="btn ghost small" onClick={() => setMade(null)}>Done</button>
        </div>
      )}
      <div className="form">
        <div className="f" style={{ flex: 2 }}>
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="them@example.com" />
        </div>
        <div className="f">
          <label>They may</label>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="entry">Only add entries</option>
            <option value="owner">Do everything</option>
          </select>
        </div>
        <div className="f" style={{ flex: 2 }}>
          <label>First password</label>
          <div className="withbtn">
            <input value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="at least 8 characters" />
            <button className="btn ghost small" onClick={() => setPassword(suggestion)}>Suggest</button>
          </div>
        </div>
        <button className="btn" disabled={busy || !email.includes('@') || password.length < 8} onClick={go}>
          {busy ? 'Adding…' : 'Add them'}
        </button>
      </div>
    </Card>
  );
}

function money(amount: number): string {
  return `$${Number(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function when(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

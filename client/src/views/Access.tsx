/** Who can open the book, and what they can use once inside. */
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
    <section className="access-page">
      <div className="dhead access-head">
        <div>
          <h2>Access</h2>
          <p className="muted">Usernames, passwords, roles, and the cash accounts entry users can spend from.</p>
        </div>
        {owner && people && <span className="chip">{people.length} user{people.length === 1 ? '' : 's'}</span>}
      </div>

      <OwnPassword say={say} />

      {owner && (
        <>
          <Card title="Users" aside={people ? `${people.length}` : undefined}>
            {!people && <Empty>Reading users…</Empty>}
            {people?.map((person) => (
              <Person
                key={person.id}
                person={person}
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
    </section>
  );
}

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
      say('Password changed. Other sessions using the old password were signed out.');
    } catch (e) { say((e as Error).message, true); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Your password" aside="security">
      <div className="form access-password-form">
        <div className="f"><label>Current password</label><input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></div>
        <div className="f"><label>New password</label><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="at least 8 characters" /></div>
        <div className={`f${mismatch ? ' needed' : ''}`}><label>Repeat new password</label><input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ready && void go()} /></div>
        <button className="btn" disabled={!ready} onClick={() => void go()}>{busy ? 'Changing…' : 'Change password'}</button>
      </div>
      {mismatch && <div className="warn">Those two new passwords do not match.</div>}
    </Card>
  );
}

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
  const [username, setUsername] = useState(person.email);
  const isYou = person.id === me.id;

  useEffect(() => setUsername(person.email), [person.email]);

  const run = async (work: () => Promise<unknown>, done: string) => {
    try { await work(); reload(); say(done); }
    catch (e) { say((e as Error).message, true); }
  };

  return (
    <div className={`person access-person${open ? ' open' : ''}`}>
      <button className="row link access-person-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="face">{person.email.slice(0, 1).toUpperCase()}</span>
        <span className="main">
          <b>{person.email}{isYou && <span className="you">you</span>}</b>
          <small>{person.lastSeen ? `last signed in ${when(person.lastSeen)}` : 'has not signed in yet'}</small>
        </span>
        <span className={`chip ${person.role}`}>{person.role === 'owner' ? 'Owner' : 'Entry only'}</span>
        <span className="chev">›</span>
      </button>

      {open && (
        <div className="personmore access-person-more">
          <div className="access-identity-grid">
            <div className="f">
              <label>Username</label>
              <div className="withbtn">
                <input value={username} autoCapitalize="none" spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
                <button className="btn ghost small" disabled={!username.trim() || username === person.email}
                  onClick={() => void run(() => api.setUsername(person.id, username), `Username changed to ${username}.`)}>Save</button>
              </div>
              <small className="field-help">Spaces and capital letters are ignored at sign-in.</small>
            </div>
            <div className="f">
              <label>Set a new password</label>
              <div className="withbtn">
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="at least 8 characters" />
                <button className="btn ghost small" disabled={password.length < 8}
                  onClick={() => { void run(() => api.resetPassword(person.id, password), `New password set for ${person.email}.`); setPassword(''); }}>Set</button>
              </div>
            </div>
          </div>

          {person.role === 'entry' && (
            <AccountAccess person={person} accounts={accounts} delegates={delegates} say={say} reload={reload} />
          )}

          <div className="personactions access-person-actions">
            <button className="btn ghost small"
              onClick={() => void run(() => api.setRole(person.id, person.role === 'owner' ? 'entry' : 'owner'),
                person.role === 'owner' ? `${person.email} is now entry-only.` : `${person.email} is now an owner.`)}>
              {person.role === 'owner' ? 'Make entry-only' : 'Make owner'}
            </button>
            {!isYou && (
              <button className="btn ghost small danger"
                onClick={() => { if (confirm(`Take away ${person.email}'s access? They will be signed out.`)) void run(() => api.removeUser(person.id), `${person.email} can no longer open the book.`); }}>
                Remove access
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
  const holder = (accountId: string) => delegates.find((d) => d.id !== person.id && d.accountIds.includes(accountId));
  const toggle = (accountId: string, checked: boolean) => setSelected((current) => checked
    ? [...new Set([...current, accountId])]
    : current.filter((id) => id !== accountId));

  const save = async () => {
    setBusy(true);
    try {
      await api.setUserAccounts(person.id, selected);
      reload();
      say(selected.length
        ? `${person.email} can spend from ${selected.length} account${selected.length === 1 ? '' : 's'}.`
        : `${person.email} no longer has a spending account.`);
    } catch (e) { say((e as Error).message, true); }
    finally { setBusy(false); }
  };

  return (
    <section className="accountaccess" aria-label={`Account access for ${person.email}`}>
      <div className="accountaccesshead">
        <div><b>Accounts they can use</b><small>Only these accounts appear in this user's spending prompt.</small></div>
        <span className="chip">{selected.length} selected</span>
      </div>
      {accounts.length === 0 ? <div className="accountaccessempty">No accounts exist yet.</div> : (
        <div className="accountaccesslist">
          {accounts.map((account) => {
            const taken = holder(account.id);
            const checked = selected.includes(account.id);
            return (
              <label className={`accountaccessrow${taken ? ' disabled' : ''}`} key={account.id}>
                <input type="checkbox" checked={checked} disabled={!!taken || busy} onChange={(e) => toggle(account.id, e.target.checked)} />
                <span className="accountaccessmain"><b>{account.name}</b><small>{taken ? `Assigned to ${taken.email}` : 'Available'}</small></span>
                <span className="num">{money(account.balance)}</span>
              </label>
            );
          })}
        </div>
      )}
      <div className="accountaccessactions">
        <span className="muted small">This changes access only, not balances.</span>
        <button className="btn small" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save accounts'}</button>
      </div>
    </section>
  );
}

function AddPerson({ suggestion, say, reload }: {
  suggestion: string;
  say: (t: string, bad?: boolean) => void;
  reload: () => void;
}) {
  const [username, setUsername] = useState('');
  const [role, setRole] = useState('entry');
  const [password, setPassword] = useState('');
  const [made, setMade] = useState<{ username: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    try {
      await api.addUser({ username, password, role });
      setMade({ username, password });
      setUsername(''); setPassword('');
      reload();
    } catch (e) { say((e as Error).message, true); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Add a user" aside="username + password">
      {made && (
        <div className="handover">
          <b>{made.username} can now open the book.</b>
          <span>First password: <code>{made.password}</code>. Give it to them securely and have them change it after signing in.</span>
          <button className="btn ghost small" onClick={() => setMade(null)}>Done</button>
        </div>
      )}
      <div className="form access-add-form">
        <div className="f access-wide"><label>Username</label><input value={username} autoCapitalize="none" spellCheck={false} onChange={(e) => setUsername(e.target.value)} placeholder="Hassan Dakik" /></div>
        <div className="f"><label>Role</label><select value={role} onChange={(e) => setRole(e.target.value)}><option value="entry">Entry only</option><option value="owner">Owner</option></select></div>
        <div className="f access-wide"><label>First password</label><div className="withbtn"><input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="at least 8 characters" /><button className="btn ghost small" onClick={() => setPassword(suggestion)}>Suggest</button></div></div>
        <button className="btn" disabled={busy || !username.trim() || password.length < 8} onClick={() => void go()}>{busy ? 'Adding…' : 'Add user'}</button>
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

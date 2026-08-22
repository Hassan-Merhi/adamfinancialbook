/**
 * The book, on one screen.
 *
 * Say what happened in the box at the top; everything below is the answer to
 * "where do I stand". Any figure opens into the entries behind it.
 */
import { useEffect, useState } from 'react';
import { api, NotSignedIn, type LoadedBook, type Me } from './api';
import SignIn from './views/SignIn';
import { flushOutbox, lastUser, looksOffline, outbox, snapshot } from './offline';
import Entry from './Entry';
import Today from './views/Today';
import Money from './views/Money';
import Projects from './views/Projects';
import People from './views/People';
import Report from './views/Report';
import Setup from './views/Setup';
import History from './views/History';
import Statement, { type Focus } from './views/Statement';
import { money } from './ui';
import './styles.css';

type View = 'today' | 'money' | 'projects' | 'people' | 'report' | 'history' | 'setup';

const NAV: { id: View; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'money', label: 'Accounts & loans' },
  { id: 'projects', label: 'Projects' },
  { id: 'people', label: 'People' },
  { id: 'report', label: 'Day report' },
  { id: 'history', label: 'History' },
  { id: 'setup', label: 'Set it up' },
];

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [book, setBook] = useState<LoadedBook | null>(null);
  const [view, setView] = useState<View>('today');
  const [focus, setFocus] = useState<Focus | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [waiting, setWaiting] = useState(outbox.all().length);
  const [offline, setOffline] = useState(!navigator.onLine);

  const reload = async () => {
    try {
      const fresh = await api.book();
      setBook(fresh);
      snapshot.save(fresh);          // so the app opens with figures next time, signal or not
      setOffline(false);
    } catch (e) {
      if (e instanceof NotSignedIn) { setMe({ user: null, needsFirstOwner: false }); return; }
      const kept = snapshot.load<LoadedBook>();
      if (kept) { setBook(kept); setOffline(true); }
      else say((e as Error).message, true);
    }
  };

  useEffect(() => {
    api.me()
      .then((m) => { setMe(m); if (m.user) { lastUser.save(m.user); reload(); } else lastUser.clear(); })
      .catch((e) => {
        // No signal: open the book as it was rather than asking someone already
        // signed in to sign in again. The cookie is still there; only the
        // confirmation is missing.
        const kept = snapshot.load<LoadedBook>();
        const who = lastUser.load<NonNullable<Me['user']>>();
        if (looksOffline(e) && kept && who) {
          setMe({ user: who, needsFirstOwner: false });
          setBook(kept);
          setOffline(true);
        } else setMe({ user: null, needsFirstOwner: false });
      });
  }, []);

  // Anything logged with no signal goes out the moment there is one.
  const flush = async () => {
    if (!outbox.all().length) return;
    try {
      const sent = await flushOutbox((input) => api.addEntry(input));
      setWaiting(outbox.all().length);
      if (sent) { await reload(); say(`${sent} ${sent === 1 ? 'entry' : 'entries'} logged from the outbox.`); }
    } catch (e) {
      setWaiting(outbox.all().length);
      say(`One queued entry was refused: ${(e as Error).message}`, true);
    }
  };

  useEffect(() => {
    const online = () => { setOffline(false); flush(); };
    const gone = () => setOffline(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', gone);
    if (navigator.onLine) flush();
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', gone); };
  }, [me?.user?.id]);

  const say = (text: string, bad?: boolean) => setNote({ text, bad });
  const run = async (work: () => Promise<unknown>, done: string) => {
    try { await work(); await reload(); say(done); }
    catch (e) { say((e as Error).message, true); }
  };
  const go = (next: View) => { setView(next); setFocus(null); setNote(null); };
  const open = (f: Focus) => { setFocus(f); setNote(null); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  if (!me) return <div className="wrap"><p className="muted">Opening the book…</p></div>;

  if (!me.user) {
    return <SignIn needsFirstOwner={me.needsFirstOwner}
      done={(next) => { setMe(next); lastUser.save(next.user); reload(); }} />;
  }

  if (!book) {
    return (
      <div className="wrap">
        <p className="muted">Opening the book…</p>
        {note?.bad && <div className="note err">{note.text}</div>}
      </div>
    );
  }

  const empty = book.businesses.length === 0;

  return (
    <div className="shell">
      <nav className="rail">
        <div className="brand">
          <b>Financial Book</b>
          <span>{money(book.balances.totalCash)} on hand</span>
        </div>
        {NAV.filter((n) => me.user!.role === 'owner' || (n.id !== 'setup' && n.id !== 'history')).map((n) => (
          <button key={n.id} className="navbtn" aria-current={!focus && view === n.id}
            onClick={() => go(n.id)}>{n.label}</button>
        ))}
        <div className="railfoot">
          <span className="muted">{me.user.email}{me.user.role === 'entry' ? ' · can enter only' : ''}</span>
          <button className="linkbtn" onClick={async () => {
            await api.logout(); lastUser.clear(); snapshot.save(null);
            setMe({ user: null, needsFirstOwner: false }); setBook(null);
          }}>Sign out</button>
        </div>
      </nav>

      <main>
        <div className="wrap">
          {(offline || waiting > 0) && (
            <div className="note">
              {offline ? 'No signal — these are the figures from the last time the book loaded. ' : ''}
              {waiting > 0
                ? `${waiting} ${waiting === 1 ? 'entry is' : 'entries are'} waiting to be sent, and will go the moment there is a network.`
                : 'Anything you log now will be sent when you are back.'}
            </div>
          )}

          <Entry book={book} reload={reload} say={say} onQueued={() => setWaiting(outbox.all().length)} />

          {note && <div className={`note ${note.bad ? 'err' : 'ok'}`}>{note.text}</div>}

          {empty && (
            <div className="note">
              The book is empty. Say <b>create a business called …</b> in the box above, then
              <b> add account … under … with $…</b> — opening balances go in as you create each one.
            </div>
          )}

          {focus
            ? <Statement book={book} focus={focus} back={() => setFocus(null)} run={run} />
            : view === 'today' ? <Today book={book} open={open} goto={go} />
            : view === 'money' ? <Money book={book} open={open} />
            : view === 'projects' ? <Projects book={book} open={open} />
            : view === 'people' ? <People book={book} open={open} />
            : view === 'report' ? <Report book={book} run={run} />
            : view === 'history' ? <History book={book} />
            : <Setup book={book} run={run} />}
        </div>
      </main>
    </div>
  );
}

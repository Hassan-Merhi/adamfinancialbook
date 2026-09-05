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
import Access from './views/Access';
import Files from './views/Files';
import Approvals from './views/Approvals';
import Statement, { type Focus } from './views/Statement';
import { money } from './ui';
import './styles.css';

type View = 'today' | 'money' | 'projects' | 'people' | 'report' | 'files' | 'history' | 'access' | 'setup' | 'approvals';

/** The long label is for the rail; the short one and the icon are for the phone. */
const NAV: { id: View; label: string; short: string; icon: string }[] = [
  { id: 'today', label: 'Today', short: 'Today',
    icon: 'M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' },
  { id: 'money', label: 'Accounts & loans', short: 'Money',
    icon: 'M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z' },
  { id: 'projects', label: 'Projects', short: 'Projects',
    icon: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
  { id: 'people', label: 'People', short: 'People',
    icon: 'M9 4.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4zM3 20c0-3.3 2.7-5 6-5s6 1.7 6 5M16 6.5a3 3 0 0 1 0 6M17.5 20c0-2.2-.7-3.7-2-4.6' },
  { id: 'report', label: 'Day report', short: 'Report',
    icon: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8 8h8M8 12h8M8 16h5' },
  { id: 'files', label: 'Receipts & files', short: 'Files',
    icon: 'M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h4' },
  { id: 'history', label: 'History', short: 'History',
    icon: 'M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.2-5.7M3 4v4h4' },
  { id: 'setup', label: 'Set it up', short: 'Setup',
    icon: 'M4 7h16M4 12h16M4 17h16M9 5v4M15 10v4M7 15v4' },
  { id: 'access', label: 'Access', short: 'Access',
    icon: 'M15.5 5a4.5 4.5 0 1 0-2.2 3.9L18 13.4V17h3.5v-3.5l-6-6A4.5 4.5 0 0 0 15.5 5zM11 5.6a1.4 1.4 0 1 1-2.8 0 1.4 1.4 0 0 1 2.8 0z' },
];

const LOOKS = [['assistant', 'Assistant'], ['ledger', 'Ledger']] as const;

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [book, setBook] = useState<LoadedBook | null>(null);
  const [view, setView] = useState<View>('today');
  const [focus, setFocus] = useState<Focus | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [waiting, setWaiting] = useState(outbox.all().length);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [look, setLook] = useState(0);
  const [approvalUnread, setApprovalUnread] = useState(0);

  // The look is only a set of tokens; nothing else in the app knows about it.
  useEffect(() => {
    try {
      const kept = localStorage.getItem('book.look');
      const found = LOOKS.findIndex(([id]) => id === kept);
      if (found > 0) setLook(found);
    } catch { /* private mode: the default look is fine */ }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-vibe', LOOKS[look][0]);
    try { localStorage.setItem('book.look', LOOKS[look][0]); } catch { /* nothing to do */ }
  }, [look]);

  const flipTheme = () => {
    const now = document.documentElement.getAttribute('data-theme');
    const dark = now ? now === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  };

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

  // Keep the launcher useful even when the approvals page is not open. The old
  // standalone wallet polled in the background; the integrated UI keeps that
  // behavior without bringing back a second visual system.
  useEffect(() => {
    if (!me?.user) { setApprovalUnread(0); return; }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/delegation/dashboard', {
          credentials: 'same-origin',
          headers: { 'x-book': '1' },
        });
        if (!res.ok) return;
        const data = await res.json() as { notifications?: Array<{ read_at: string | null }> };
        if (!cancelled) setApprovalUnread((data.notifications || []).filter((n) => !n.read_at).length);
      } catch { /* offline or temporarily unavailable: keep the last count */ }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 12_000);
    return () => { cancelled = true; window.clearInterval(timer); };
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
  const entryOnly = me.user.role === 'entry';
  const entryLanding = entryOnly && view === 'today' && !focus;
  const showPrompt = !entryOnly || view === 'today';

  return (
    <div className="shell">
      {/* On a phone the rail sits at the bottom, so the name and the figure live up here. */}
      <header className="topbar">
        <b>Financial Book</b>
        <span className="num">{money(book.balances.totalCash)}</span>
      </header>

      <nav className="rail">
        <div className="brand">
          <b>Financial Book</b>
          <span>{money(book.balances.totalCash)} on hand</span>
        </div>
        {NAV.filter((n) => me.user!.role === 'owner' || (n.id !== 'setup' && n.id !== 'history' && n.id !== 'files')).map((n) => (
          <button key={n.id} className="navbtn" aria-current={!focus && view === n.id}
            onClick={() => go(n.id)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={n.icon} /></svg>
            <span className="long">{n.label}</span>
            <span className="short">{n.short}</span>
          </button>
        ))}
        <div className="railfoot">
          <span className="muted">{me.user.email}{me.user.role === 'entry' ? ' · can enter only' : ''}</span>
          <button className="linkbtn" onClick={async () => {
            await api.logout(); lastUser.clear(); snapshot.save(null);
            setMe({ user: null, needsFirstOwner: false }); setBook(null);
          }}>Sign out</button>
        </div>
      </nav>

      {/* Owners keep the fast-entry box on every view. Entry-only users get one
          dedicated Today landing page for the prompt, so pages they are allowed
          to open stay focused on that page's own content. */}
      <div className="content">
        {showPrompt && (
          <div className="dockable">
            {(offline || waiting > 0) && (
              <div className="note docknote">
                {offline ? 'No signal — these are the figures from the last time the book loaded. ' : ''}
                {waiting > 0
                  ? `${waiting} ${waiting === 1 ? 'entry is' : 'entries are'} waiting to be sent, and will go the moment there is a network.`
                  : 'Anything you log now will be sent when you are back.'}
              </div>
            )}
            <Entry book={book} reload={reload} say={say} onQueued={() => setWaiting(outbox.all().length)} />
          </div>
        )}

        {(!entryLanding || note) && (
          <main>
            <div className="wrap">
              {note && <div className={`note ${note.bad ? 'err' : 'ok'}`}>{note.text}</div>}

              {!entryLanding && (
                <>
                  {empty && view === 'today' && !focus && (
                    <div className="note">
                      The book is empty. Say <b>create a business called …</b> in the box, then
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
                    : view === 'files' ? <Files book={book} />
                    : view === 'history' ? <History book={book} />
                    : view === 'access' ? <Access me={me.user!} say={say} />
                    : view === 'approvals' ? <Approvals me={me.user!} say={say} />
                    : <Setup book={book} run={run} />}

                  {/* the same two switches as the toggles, for a screen with no room for them */}
                  <div className="lookrow">
                    <span className="lab">Look</span>
                    {LOOKS.map(([id, label], i) => (
                      <button key={id} className="tab" aria-pressed={look === i} onClick={() => setLook(i)}>{label}</button>
                    ))}
                    <button className="tab" onClick={flipTheme}>Light / dark</button>
                  </div>
                </>
              )}
            </div>
          </main>
        )}
      </div>

      <button className="approval-launcher" aria-current={!focus && view === 'approvals'} onClick={() => go('approvals')}>
        {entryOnly ? 'My wallet' : 'Approvals'}
        {approvalUnread > 0 && <span className="approval-badge">{approvalUnread > 99 ? '99+' : approvalUnread}</span>}
      </button>

      <div className="toggles">
        <button className="toggle" onClick={() => setLook((look + 1) % LOOKS.length)}>
          Look · {LOOKS[look][1]}
        </button>
        <button className="toggle" onClick={flipTheme}>Theme</button>
      </div>
    </div>
  );
}

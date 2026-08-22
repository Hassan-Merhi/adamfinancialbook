/**
 * The book, on one screen.
 *
 * Say what happened in the box at the top; everything below is the answer to
 * "where do I stand". Any figure opens into the entries behind it.
 */
import { useEffect, useState } from 'react';
import { api, type LoadedBook } from './api';
import Entry from './Entry';
import Today from './views/Today';
import Money from './views/Money';
import Projects from './views/Projects';
import People from './views/People';
import Report from './views/Report';
import Setup from './views/Setup';
import Statement, { type Focus } from './views/Statement';
import { money } from './ui';
import './styles.css';

type View = 'today' | 'money' | 'projects' | 'people' | 'report' | 'setup';

const NAV: { id: View; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'money', label: 'Accounts & loans' },
  { id: 'projects', label: 'Projects' },
  { id: 'people', label: 'People' },
  { id: 'report', label: 'Day report' },
  { id: 'setup', label: 'Set it up' },
];

export default function App() {
  const [book, setBook] = useState<LoadedBook | null>(null);
  const [view, setView] = useState<View>('today');
  const [focus, setFocus] = useState<Focus | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);

  const reload = () => api.book().then(setBook).catch((e) => say(e.message, true));
  useEffect(() => { reload(); }, []);

  const say = (text: string, bad?: boolean) => setNote({ text, bad });
  const run = async (work: () => Promise<unknown>, done: string) => {
    try { await work(); await reload(); say(done); }
    catch (e) { say((e as Error).message, true); }
  };
  const go = (next: View) => { setView(next); setFocus(null); setNote(null); };
  const open = (f: Focus) => { setFocus(f); setNote(null); window.scrollTo({ top: 0, behavior: 'smooth' }); };

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
        {NAV.map((n) => (
          <button key={n.id} className="navbtn" aria-current={!focus && view === n.id}
            onClick={() => go(n.id)}>{n.label}</button>
        ))}
      </nav>

      <main>
        <div className="wrap">
          <Entry book={book} reload={reload} say={say} />

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
            : <Setup book={book} run={run} />}
        </div>
      </main>
    </div>
  );
}

/**
 * The book, on one screen.
 *
 * Say what happened in the box at the top; everything below is the answer to
 * "where do I stand". Any figure opens into the entries behind it.
 */
import { useEffect, useState } from 'react';
import { api, NotSignedIn, type EvidenceDashboard, type LoadedBook, type Me } from './api';
import SignIn from './views/SignIn';
import { flushOutbox, lastUser, looksOffline, outbox, snapshot } from './offline';
import Entry from './Entry';
import Today from './views/Today';
import Money from './views/Money';
import Projects from './views/Projects';
import People from './views/People';
import Attention from './views/Attention';
import Report from './views/Report';
import Setup from './views/Setup';
import History from './views/History';
import Access from './views/Access';
import Files from './views/Files';
import Approvals from './views/Approvals';
import Statement, { type Focus } from './views/Statement';
import GlobalSearch from './GlobalSearch';
import LanguageControl from './LanguageControl';
import LoadingSkeleton from './LoadingSkeleton';
import { attentionCounts } from './attention';
import type { SearchAction } from './search';
import type { PromptAction } from '../../shared/prompt-actions';
import { money } from './ui';
import './styles.css';
import './navigation.css';
import './ux6.css';
import './mobile-core.css';

type View = 'today' | 'money' | 'projects' | 'people' | 'attention' | 'report' | 'files' | 'history' | 'access' | 'setup' | 'approvals';
type NavItem = { id: View; label: string; short: string; icon: string; ownerOnly?: boolean };

const PRIMARY_NAV: NavItem[] = [
  { id: 'today', label: 'Today', short: 'Today', icon: 'M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' },
  { id: 'money', label: 'Accounts & loans', short: 'Money', icon: 'M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z' },
  { id: 'projects', label: 'Projects', short: 'Projects', icon: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
  { id: 'people', label: 'People', short: 'People', icon: 'M9 4.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4zM3 20c0-3.3 2.7-5 6-5s6 1.7 6 5M16 6.5a3 3 0 0 1 0 6M17.5 20c0-2.2-.7-3.7-2-4.6' },
];

const MORE_NAV: NavItem[] = [
  { id: 'attention', label: 'Needs attention', short: 'Attention', icon: 'M12 3 2.8 19h18.4L12 3zM12 9v4M12 16.5h.01' },
  { id: 'report', label: 'Day report', short: 'Report', icon: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8 8h8M8 12h8M8 16h5' },
  { id: 'approvals', label: 'Approvals', short: 'Approvals', icon: 'M5 12.5 9.2 17 19 7' },
  { id: 'files', label: 'Receipts & files', short: 'Files', ownerOnly: true, icon: 'M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h4' },
  { id: 'history', label: 'History', short: 'History', ownerOnly: true, icon: 'M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.2-5.7M3 4v4h4' },
  { id: 'access', label: 'Access', short: 'Access', icon: 'M15.5 5a4.5 4.5 0 1 0-2.2 3.9L18 13.4V17h3.5v-3.5l-6-6A4.5 4.5 0 0 0 15.5 5zM11 5.6a1.4 1.4 0 1 1-2.8 0 1.4 1.4 0 0 1 2.8 0z' },
  { id: 'setup', label: 'Set it up', short: 'Setup', ownerOnly: true, icon: 'M4 7h16M4 12h16M4 17h16M9 5v4M15 10v4M7 15v4' },
];

const MORE_ICON = 'M5 12h.01M12 12h.01M19 12h.01';
const SEARCH_ICON = 'm21 21-4.2-4.2M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4z';
const DASHBOARD_REFRESH_MS = 45_000;

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [book, setBook] = useState<LoadedBook | null>(null);
  const [dashboard, setDashboard] = useState<EvidenceDashboard | null>(null);
  const [view, setView] = useState<View>('today');
  const [focus, setFocus] = useState<Focus | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [waiting, setWaiting] = useState(outbox.all().length);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [missingReceiptCount, setMissingReceiptCount] = useState(0);

  useEffect(() => {
    document.documentElement.setAttribute('data-vibe', 'assistant');
    try { localStorage.removeItem('book.look'); } catch { /* private mode */ }
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMoreOpen(false);
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [moreOpen]);

  const flipTheme = () => {
    const now = document.documentElement.getAttribute('data-theme');
    const dark = now ? now === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  };

  const say = (text: string, bad?: boolean) => setNote({ text, bad });

  const reload = async () => {
    try {
      const fresh = await api.book();
      setBook(fresh);
      snapshot.save(fresh);
      setOffline(false);
    } catch (e) {
      if (e instanceof NotSignedIn) {
        setMe({ user: null, needsFirstOwner: false });
        return;
      }
      const kept = snapshot.load<LoadedBook>();
      if (kept) {
        setBook(kept);
        setOffline(true);
      } else {
        say((e as Error).message, true);
      }
    }
  };

  const refreshDashboard = async () => {
    if (!me?.user || !navigator.onLine || document.visibilityState === 'hidden') return;
    try {
      setDashboard(await api.evidenceDashboard());
    } catch {
      /* Keep the last attention snapshot while offline or temporarily unavailable. */
    }
  };

  useEffect(() => {
    api.me()
      .then((next) => {
        setMe(next);
        if (next.user) {
          lastUser.save(next.user);
          void reload();
        } else {
          lastUser.clear();
        }
      })
      .catch((e) => {
        const kept = snapshot.load<LoadedBook>();
        const who = lastUser.load<NonNullable<Me['user']>>();
        if (looksOffline(e) && kept && who) {
          setMe({ user: who, needsFirstOwner: false });
          setBook(kept);
          setOffline(true);
        } else {
          setMe({ user: null, needsFirstOwner: false });
        }
      });
  }, []);

  const flush = async () => {
    if (!outbox.all().length) return;
    try {
      const sent = await flushOutbox((input) => api.addEntry(input));
      setWaiting(outbox.all().length);
      if (sent) {
        await reload();
        say(`${sent} ${sent === 1 ? 'entry' : 'entries'} logged from the outbox.`);
      }
    } catch (e) {
      setWaiting(outbox.all().length);
      say(`One queued entry was refused: ${(e as Error).message}`, true);
    }
  };

  useEffect(() => {
    const online = () => { setOffline(false); void flush(); void refreshDashboard(); };
    const gone = () => setOffline(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', gone);
    if (navigator.onLine) void flush();
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', gone);
    };
  }, [me?.user?.id]);

  useEffect(() => {
    if (!me?.user) {
      setDashboard(null);
      setMissingReceiptCount(0);
      return;
    }
    let timer: number | null = null;
    const stopTimer = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const startTimer = () => {
      stopTimer();
      if (document.visibilityState === 'visible') {
        timer = window.setInterval(() => { void refreshDashboard(); }, DASHBOARD_REFRESH_MS);
      }
    };
    const resume = () => {
      if (document.visibilityState !== 'visible') {
        stopTimer();
        return;
      }
      void refreshDashboard();
      startTimer();
    };
    resume();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      stopTimer();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, [me?.user?.id]);

  const run = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work();
      await reload();
      say(done);
    } catch (e) {
      say((e as Error).message, true);
    }
  };

  const refreshAll = async () => { await Promise.all([reload(), refreshDashboard()]); };
  const signOut = async () => {
    await api.logout();
    lastUser.clear();
    snapshot.save(null);
    setMe({ user: null, needsFirstOwner: false });
    setBook(null);
    setDashboard(null);
    setMissingReceiptCount(0);
    setMoreOpen(false);
    setSearchOpen(false);
  };
  const go = (next: View) => {
    setView(next);
    setFocus(null);
    setNote(null);
    setMoreOpen(false);
  };
  const open = (nextFocus: Focus) => {
    setFocus(nextFocus);
    setNote(null);
    setMoreOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (!me) return <LoadingSkeleton />;
  if (!me.user) {
    return <SignIn needsFirstOwner={me.needsFirstOwner}
      done={(next) => { setMe(next); lastUser.save(next.user); void reload(); }} />;
  }
  if (!book) {
    return (
      <>
        <LoadingSkeleton />
        {note?.bad && <div className="note err" role="alert">{note.text}</div>}
      </>
    );
  }

  const empty = book.businesses.length === 0;
  const entryOnly = me.user.role === 'entry';
  const entryLanding = entryOnly && view === 'today' && !focus;
  const showPrompt = !entryOnly || view === 'today';
  const visibleMore = MORE_NAV.filter((item) => !item.ownerOnly || me.user!.role === 'owner');
  const moreIsCurrent = !focus && visibleMore.some((item) => item.id === view);
  const attention = attentionCounts(book, dashboard, missingReceiptCount);

  const handlePromptAction = (action: PromptAction) => {
    if (action.mode === 'focus') {
      open(action.target);
      return;
    }
    if (action.view === 'more') {
      setFocus(null);
      setNote(null);
      setMoreOpen(true);
      return;
    }
    const next = action.view as View;
    const nav = MORE_NAV.find((item) => item.id === next);
    if (entryOnly && nav?.ownerOnly) {
      say(`${nav.label} is owner-only.`, true);
      return;
    }
    go(next);
  };

  const handleSearchAction = (action: SearchAction) => {
    if (action.mode === 'focus') open(action.target);
    else go(action.view as View);
  };

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">Skip to content</a>

      <header className="topbar">
        <b>Financial Book</b>
        <div className="topbar-search-wrap">
          <button className="search-trigger mobile" onClick={() => setSearchOpen(true)} aria-label="Search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={SEARCH_ICON} /></svg>
            <span>Search</span>
          </button>
        </div>
      </header>

      <nav className="rail" aria-label="Main navigation">
        <div className="brand">
          <b>Financial Book</b>
          <span>{money(book.balances.totalCash)} on hand</span>
          <button className="search-trigger desktop" onClick={() => setSearchOpen(true)} aria-label="Search everything">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={SEARCH_ICON} /></svg>
            <span>Search everything</span>
            <kbd>⌘K</kbd>
          </button>
        </div>

        {PRIMARY_NAV.map((item) => (
          <button key={item.id} className="navbtn" aria-current={!focus && view === item.id ? 'page' : undefined}
            onClick={() => go(item.id)} aria-label={item.label}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={item.icon} /></svg>
            <span className="long">{item.label}</span>
            <span className="short">{item.short}</span>
          </button>
        ))}

        <div className="moregroup">
          <button className="navbtn morebtn" aria-current={moreIsCurrent ? 'page' : undefined}
            aria-expanded={moreOpen} aria-haspopup="dialog" aria-label="More pages"
            onClick={() => setMoreOpen((openNow) => !openNow)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={MORE_ICON} /></svg>
            <span className="long">More</span>
            <span className="short">More</span>
            {attention.total > 0 && (
              <span className="navbadge" aria-label={`${attention.total} items need attention`}>
                {attention.total > 99 ? '99+' : attention.total}
              </span>
            )}
          </button>

          {moreOpen && (
            <>
              <button type="button" className="morebackdrop" onClick={() => setMoreOpen(false)} aria-label="Close More" />
              <section className="moremenu" role="dialog" aria-modal="true" aria-label="More pages and settings">
                <header className="moremenu-head">
                  <span className="moremenu-head-copy">
                    <b>More</b>
                    <span>Pages and settings</span>
                  </span>
                  <button type="button" className="moremenu-close" onClick={() => setMoreOpen(false)} aria-label="Close More">×</button>
                </header>

                <div className="moremenu-pages">
                  {visibleMore.map((item) => {
                    const label = item.id === 'approvals' && entryOnly ? 'My wallet' : item.label;
                    return (
                      <button key={item.id} className="moreitem"
                        aria-current={!focus && view === item.id ? 'page' : undefined}
                        onClick={() => go(item.id)}>
                        <span className="moreitem-main">
                          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={item.icon} /></svg>
                          <span>{label}</span>
                        </span>
                        {item.id === 'attention' && attention.total > 0 && (
                          <span className="navbadge inline">{attention.total > 99 ? '99+' : attention.total}</span>
                        )}
                      </button>
                    );
                  })}
                </div>

                <div className="moremobile">
                  <span className="moremobile-title">Settings</span>
                  <div className="morelanguage">
                    <span className="moretool-label">Language</span>
                    <LanguageControl compact />
                  </div>
                  <button type="button" className="moreutility" onClick={flipTheme}>
                    <span>Appearance</span>
                    <strong>Light / dark</strong>
                  </button>
                  <div className="moreaccount">
                    <span className="moreaccount-copy">
                      <b>{entryOnly ? 'Entry user' : 'Account'}</b>
                      <span>{me.user.email}</span>
                    </span>
                    <button type="button" className="more-signout" onClick={() => { void signOut(); }}>Sign out</button>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>

        <div className="railfoot">
          <span className="muted">{me.user.email}{entryOnly ? ' · can enter only' : ''}</span>
          <div className="language-desktop"><LanguageControl /></div>
          <button className="linkbtn" onClick={() => { void signOut(); }}>Sign out</button>
        </div>
      </nav>

      <div className="content">
        {showPrompt && (
          <div className="dockable">
            {(offline || waiting > 0) && (
              <div className="note docknote" role="status" aria-live="polite">
                {offline ? 'No signal — these are the figures from the last time the book loaded. ' : ''}
                {waiting > 0
                  ? `${waiting} ${waiting === 1 ? 'entry is' : 'entries are'} waiting to be sent, and will go the moment there is a network.`
                  : 'Anything you log now will be sent when you are back.'}
              </div>
            )}
            <Entry book={book} reload={reload} say={say}
              onQueued={() => setWaiting(outbox.all().length)} onAction={handlePromptAction} />
          </div>
        )}

        {(!entryLanding || note) && (
          <main id="main-content" tabIndex={-1}>
            <div className="wrap">
              {note && (
                <div className={`note ${note.bad ? 'err' : 'ok'}`} role={note.bad ? 'alert' : 'status'} aria-live="polite">
                  {note.text}
                </div>
              )}

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
                    : view === 'today' ? <Today book={book} open={open} goto={go} attentionCount={attention.total} />
                    : view === 'money' ? <Money book={book} open={open} />
                    : view === 'projects' ? <Projects book={book} open={open} />
                    : view === 'people' ? <People book={book} open={open} />
                    : view === 'attention' ? <Attention
                        book={book}
                        dashboard={dashboard}
                        role={me.user.role}
                        open={open}
                        goto={go}
                        refresh={refreshAll}
                        say={say}
                        onMissingCount={setMissingReceiptCount}
                      />
                    : view === 'report' ? <Report book={book} run={run} />
                    : view === 'files' ? <Files book={book} />
                    : view === 'history' ? <History book={book} />
                    : view === 'access' ? <Access me={me.user} say={say} />
                    : view === 'approvals' ? <Approvals me={me.user} say={say} />
                    : <Setup book={book} run={run} />}
                </>
              )}
            </div>
          </main>
        )}
      </div>

      <GlobalSearch
        open={searchOpen}
        onOpen={() => setSearchOpen(true)}
        onClose={() => setSearchOpen(false)}
        book={book}
        dashboard={dashboard}
        owner={!entryOnly}
        onChoose={handleSearchAction}
      />
    </div>
  );
}

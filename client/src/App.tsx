/**
 * The book, on one screen.
 *
 * Say what happened in the box at the top; everything below is the answer to
 * "where do I stand". Any figure opens into the entries behind it.
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, NotSignedIn, type EvidenceDashboard, type LoadedBook, type Me } from './api';
import SignIn from './views/SignIn';
import { flushOutbox, lastUser, looksOffline, outbox, snapshot } from './offline';
import Entry from './Entry';
import Today from './views/Today';
import type { Focus } from './views/Statement';
import LanguageControl from './LanguageControl';
import LoadingSkeleton from './LoadingSkeleton';
import { attentionCounts } from './attention';
import { useModalFocus } from './dialog-a11y';
import type { SearchAction } from './search';
import type { PromptAction } from '../../shared/prompt-actions';
import { money } from './ui';
import './styles.css';
import './navigation.css';
import './ux6.css';
import './mobile-core.css';
import './daily-mobile.css';
import './performance-mobile.css';
import './final-polish.css';

type View = 'today' | 'money' | 'projects' | 'people' | 'attention' | 'report' | 'files' | 'history' | 'access' | 'setup' | 'approvals';
type NavItem = { id: View; label: string; short: string; icon: string; ownerOnly?: boolean };

/*
 * Today + the prompt are the only signed-in experience needed for startup.
 * Everything else is split into a route-sized chunk and fetched only when the
 * user actually asks for it. Keeping the loader functions lets taps begin the
 * download before React renders the Suspense boundary.
 */
const loadMoney = () => import('./views/Money');
const loadProjects = () => import('./views/Projects');
const loadPeople = () => import('./views/People');
const loadAttention = () => import('./views/Attention');
const loadReport = () => import('./views/Report');
const loadSetup = () => import('./views/Setup');
const loadHistory = () => import('./views/History');
const loadAccess = () => import('./views/Access');
const loadFiles = () => import('./views/Files');
const loadApprovals = () => import('./views/Approvals');
const loadStatement = () => import('./views/Statement');
const loadGlobalSearch = () => import('./GlobalSearch');

const Money = lazy(loadMoney);
const Projects = lazy(loadProjects);
const People = lazy(loadPeople);
const Attention = lazy(loadAttention);
const Report = lazy(loadReport);
const Setup = lazy(loadSetup);
const History = lazy(loadHistory);
const Access = lazy(loadAccess);
const Files = lazy(loadFiles);
const Approvals = lazy(loadApprovals);
const Statement = lazy(loadStatement);
const GlobalSearch = lazy(loadGlobalSearch);

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
const DASHBOARD_DEDUPE_MS = 10_000;

function loadViewModule(view: View): Promise<unknown> | null {
  switch (view) {
    case 'money': return loadMoney();
    case 'projects': return loadProjects();
    case 'people': return loadPeople();
    case 'attention': return loadAttention();
    case 'report': return loadReport();
    case 'files': return loadFiles();
    case 'history': return loadHistory();
    case 'access': return loadAccess();
    case 'setup': return loadSetup();
    case 'approvals': return loadApprovals();
    default: return null;
  }
}

function ViewLoading() {
  return (
    <div className="view-loading" role="status" aria-live="polite" aria-label="Loading page">
      <span className="view-loading-title" />
      <span className="view-loading-block" />
      <span className="view-loading-block short" />
    </div>
  );
}

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
  const dashboardRefreshing = useRef(false);
  const lastDashboardRefresh = useRef(0);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreDialogRef = useRef<HTMLElement>(null);
  const moreCloseRef = useRef<HTMLButtonElement>(null);
  useModalFocus(moreOpen, moreDialogRef, () => setMoreOpen(false), moreCloseRef, moreButtonRef);

  useEffect(() => {
    document.documentElement.setAttribute('data-vibe', 'assistant');
    try { localStorage.removeItem('book.look'); } catch { /* private mode */ }
  }, []);

  useEffect(() => {
    const current = focus ? 'Statement' : [...PRIMARY_NAV, ...MORE_NAV].find((item) => item.id === view)?.label ?? 'Financial Book';
    document.title = current === 'Today' ? 'Financial Book' : `${current} · Financial Book`;
  }, [view, focus]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setMoreOpen(false);
        void loadGlobalSearch();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  const flipTheme = () => {
    const now = document.documentElement.getAttribute('data-theme');
    const dark = now ? now === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('book.theme', next); } catch { /* private mode */ }
  };

  const say = (text: string, bad?: boolean) => setNote({ text, bad });

  const refreshProjection = () => {
    setWaiting(outbox.all().length);
    const projected = snapshot.load<LoadedBook>();
    if (projected) setBook(projected);
  };

  const reload = async () => {
    try {
      const fresh = await api.overview();
      await snapshot.save(fresh);
      setBook(snapshot.load<LoadedBook>() ?? fresh);
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

  const refreshDashboard = async (force = false) => {
    if (!me?.user || !navigator.onLine || document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (dashboardRefreshing.current || (!force && now - lastDashboardRefresh.current < DASHBOARD_DEDUPE_MS)) return;
    dashboardRefreshing.current = true;
    try {
      setDashboard(await api.evidenceDashboard());
      lastDashboardRefresh.current = Date.now();
    } catch {
      /* Keep the last attention snapshot while offline or temporarily unavailable. */
    } finally {
      dashboardRefreshing.current = false;
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
      refreshProjection();
      if (sent) {
        await Promise.all([reload(), refreshDashboard(true)]);
        say(`${sent} ${sent === 1 ? 'entry' : 'entries'} logged from the outbox.`);
      }
    } catch (e) {
      refreshProjection();
      say(`One queued entry was refused: ${(e as Error).message}`, true);
    }
  };

  useEffect(() => {
    const online = () => { setOffline(false); void flush(); void refreshDashboard(true); };
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
    const resume = () => {
      if (document.visibilityState === 'visible') void refreshDashboard();
    };
    void refreshDashboard(true);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, [me?.user?.id]);

  const run = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work();
      await Promise.all([reload(), refreshDashboard(true)]);
      say(done);
    } catch (e) {
      say((e as Error).message, true);
    }
  };

  const refreshAll = async () => { await Promise.all([reload(), refreshDashboard(true)]); };
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
    const pending = loadViewModule(next);
    if (pending) void pending;
    if (next === 'attention' || next === 'approvals') void refreshDashboard(true);
    setView(next);
    setFocus(null);
    setNote(null);
    setMoreOpen(false);
  };
  const open = (nextFocus: Focus) => {
    void loadStatement();
    setFocus(nextFocus);
    setNote(null);
    setMoreOpen(false);
    window.scrollTo({
      top: 0,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  };
  const openSearch = () => {
    setMoreOpen(false);
    void loadGlobalSearch();
    setSearchOpen(true);
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
          <button type="button" className="search-trigger mobile" onClick={openSearch} aria-label="Search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={SEARCH_ICON} /></svg>
            <span>Search</span>
          </button>
        </div>
      </header>

      <nav className="rail" aria-label="Main navigation">
        <div className="brand">
          <b>Financial Book</b>
          <span>{money(book.balances.totalCash)} on hand</span>
          <button type="button" className="search-trigger desktop" onClick={openSearch} aria-label="Search everything">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={SEARCH_ICON} /></svg>
            <span>Search everything</span>
            <kbd>⌘K</kbd>
          </button>
        </div>

        {PRIMARY_NAV.map((item) => (
          <button type="button" key={item.id} className="navbtn" aria-current={!focus && view === item.id ? 'page' : undefined}
            onPointerDown={() => { const pending = loadViewModule(item.id); if (pending) void pending; }}
            onClick={() => go(item.id)} aria-label={item.label}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={item.icon} /></svg>
            <span className="long">{item.label}</span>
            <span className="short">{item.short}</span>
          </button>
        ))}

        <div className="moregroup">
          <button ref={moreButtonRef} type="button" className="navbtn morebtn" aria-current={moreIsCurrent ? 'page' : undefined}
            aria-expanded={moreOpen} aria-haspopup="dialog" aria-controls="more-pages-dialog" aria-label="More pages"
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
              <button type="button" tabIndex={-1} aria-hidden="true" className="morebackdrop" onClick={() => setMoreOpen(false)} />
              <section ref={moreDialogRef} id="more-pages-dialog" tabIndex={-1} className="moremenu" role="dialog" aria-modal="true" aria-labelledby="more-menu-title">
                <header className="moremenu-head">
                  <span className="moremenu-head-copy">
                    <b id="more-menu-title">More</b>
                    <span>Pages and settings</span>
                  </span>
                  <button ref={moreCloseRef} type="button" className="moremenu-close" onClick={() => setMoreOpen(false)} aria-label="Close More">×</button>
                </header>

                <div className="moremenu-pages">
                  {visibleMore.map((item) => {
                    const label = item.id === 'approvals' && entryOnly ? 'My wallet' : item.label;
                    return (
                      <button type="button" key={item.id} className="moreitem"
                        aria-current={!focus && view === item.id ? 'page' : undefined}
                        onPointerDown={() => { const pending = loadViewModule(item.id); if (pending) void pending; }}
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
          <button type="button" className="linkbtn" onClick={() => { void signOut(); }}>Sign out</button>
        </div>
      </nav>

      <div className="content">
        {showPrompt && (
          <div className="dockable">
            {(offline || waiting > 0) && (
              <div className="note docknote" role="status" aria-live="polite">
                {offline
                  ? waiting > 0
                    ? 'No signal — balances below are projected from the last confirmed book plus your unsynced entries. '
                    : 'No signal — showing the last server-confirmed book. '
                  : waiting > 0
                    ? 'Sync pending — balances include unsynced entries until the server confirms them. '
                    : ''}
                {waiting > 0
                  ? `${waiting} ${waiting === 1 ? 'entry is' : 'entries are'} waiting to be sent, and will go the moment there is a network.`
                  : 'Anything you log now will be sent when you are back.'}
              </div>
            )}
            <Entry book={book} reload={reload} say={say}
              onQueued={refreshProjection} onAction={handlePromptAction} />
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

                  <Suspense fallback={<ViewLoading />}>
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
                  </Suspense>
                </>
              )}
            </div>
          </main>
        )}
      </div>

      {searchOpen && (
        <Suspense fallback={null}>
          <GlobalSearch
            open
            onOpen={openSearch}
            onClose={() => setSearchOpen(false)}
            book={book}
            dashboard={dashboard}
            owner={me.user.role === 'owner'}
            onChoose={handleSearchAction}
          />
        </Suspense>
      )}
    </div>
  );
}

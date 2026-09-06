import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type EvidenceDashboard, type LoadedBook } from './api';
import { useModalFocus } from './dialog-a11y';
import { searchEverything, type SearchAction, type SearchHit } from './search';
import './global-search.css';

export default function GlobalSearch({ open, onOpen, onClose, book, dashboard, owner, onChoose }: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  book: LoadedBook;
  dashboard: EvidenceDashboard | null;
  owner: boolean;
  onChoose: (action: SearchAction) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<SearchHit[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  useModalFocus(open, dialog, onClose, input);

  const local = useMemo(
    () => searchEverything(query, book, dashboard, owner, 20),
    [query, book, dashboard, owner],
  );
  const results = useMemo(() => {
    const found = new Map<string, SearchHit>();
    for (const hit of [...local, ...remote]) {
      const previous = found.get(hit.id);
      if (!previous || hit.score > previous.score) found.set(hit.id, hit);
    }
    return [...found.values()]
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, 14);
  }, [local, remote]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        open ? onClose() : onOpen();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, onOpen, onClose]);

  useEffect(() => {
    if (open) setActive(0);
  }, [open]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    const term = query.trim();
    if (!open || term.length < 2) {
      setRemote([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api.searchEntries(term, 12)
        .then(({ items }) => {
          if (cancelled) return;
          setRemote(items.map((item, index): SearchHit => ({
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
            group: 'Activity',
            score: 72 - index,
            action: item.targetType && item.targetId
              ? { mode: 'focus', target: { type: item.targetType, id: item.targetId } }
              : { mode: 'view', view: owner ? 'history' : 'today' },
          })));
        })
        .catch(() => { if (!cancelled) setRemote([]); });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query, owner]);

  const choose = (action: SearchAction) => {
    onChoose(action);
    setQuery('');
    setRemote([]);
    onClose();
  };

  if (!open) return null;

  const activeId = results[active] ? `global-search-result-${active}` : undefined;

  return (
    <div className="searchbackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialog} tabIndex={-1} className="searchdialog" role="dialog" aria-modal="true" aria-label="Search the financial book">
        <div className="searchbox">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.2-4.2M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4z" /></svg>
          <input
            ref={input}
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls="global-search-results"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((value) => Math.max(0, Math.min(results.length - 1, value + 1)));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((value) => Math.max(0, value - 1));
              } else if (event.key === 'Enter' && results[active]) {
                event.preventDefault();
                choose(results[active].action);
              }
            }}
            placeholder="Search accounts, people, projects, entries, approvals…"
            aria-label="Search"
          />
          <button type="button" className="search-close" onClick={onClose} aria-label="Close search">×</button>
        </div>

        <div id="global-search-results" className="searchresults" role="listbox" aria-label="Search results">
          {results.length === 0 ? (
            <div className="search-empty">
              <b>No match</b>
              <span>Try an account, person, project, amount, purpose, approval, or page name.</span>
            </div>
          ) : results.map((result, index) => (
            <button
              id={`global-search-result-${index}`}
              key={result.id}
              type="button"
              role="option"
              aria-selected={active === index}
              className={`searchresult${active === index ? ' active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(result.action)}
            >
              <span className="searchresult-main">
                <b>{result.title}</b>
                <small>{result.subtitle}</small>
              </span>
              <span className="searchresult-group">{result.group}</span>
            </button>
          ))}
        </div>

        <footer className="searchfoot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
          <span>⌘/Ctrl + K anywhere</span>
        </footer>
      </section>
    </div>
  );
}

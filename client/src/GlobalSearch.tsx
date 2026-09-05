import { useEffect, useMemo, useRef, useState } from 'react';
import type { EvidenceDashboard, LoadedBook } from './api';
import { searchEverything, type SearchAction } from './search';
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
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(
    () => searchEverything(query, book, dashboard, owner),
    [query, book, dashboard, owner],
  );

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        open ? onClose() : onOpen();
      } else if (event.key === 'Escape' && open) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, onOpen, onClose]);

  useEffect(() => {
    if (!open) return;
    setActive(0);
    window.setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  useEffect(() => setActive(0), [query]);

  const choose = (action: SearchAction) => {
    onChoose(action);
    setQuery('');
    onClose();
  };

  if (!open) return null;

  return (
    <div className="searchbackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="searchdialog" role="dialog" aria-modal="true" aria-label="Search the financial book">
        <div className="searchbox">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.2-4.2M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4z" /></svg>
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((value) => Math.min(results.length - 1, value + 1));
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
          <kbd>Esc</kbd>
        </div>

        <div className="searchresults" role="listbox" aria-label="Search results">
          {results.length === 0 ? (
            <div className="search-empty">
              <b>No match</b>
              <span>Try an account, person, project, amount, purpose, approval, or page name.</span>
            </div>
          ) : results.map((result, index) => (
            <button
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
          <span>⌘/Ctrl + K anywhere</span>
        </footer>
      </section>
    </div>
  );
}

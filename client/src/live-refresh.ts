export const LIVE_MUTATION_EVENT = 'book:live-mutation';

export interface LiveMutationImpact {
  book: boolean;
  dashboard: boolean;
}

export interface LiveMutationDetail extends LiveMutationImpact {
  path: string;
  method: string;
  at: number;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Describe which top-level client snapshots a successful API write can make
 * stale. This is deliberately about UI revalidation only: the server remains
 * the source of truth and all accounting rules stay in the shared engine.
 */
export function classifyLiveMutation(path: string, method: string): LiveMutationImpact | null {
  const verb = method.toUpperCase();
  if (READ_METHODS.has(verb) || !path.startsWith('/api/')) return null;

  // Authentication/security actions manage their own signed-in state. They do
  // not reshape the financial book or delegation dashboard.
  if (
    path === '/api/login'
    || path === '/api/logout'
    || path === '/api/first-owner'
    || path === '/api/password'
    || path.startsWith('/api/security/')
    || path === '/api/security'
  ) {
    return null;
  }

  const coreBookWrite =
    path === '/api/reset-book'
    || /^\/api\/(?:entries|businesses|accounts|projects|people|loans|reminders)(?:\/|$)/.test(path);

  const delegatedBookWrite =
    /^\/api\/delegation\/transfers\/[^/]+\/confirm$/.test(path)
    || path === '/api/delegation/expense-reviews/assign';

  const book = coreBookWrite || delegatedBookWrite;
  const dashboard =
    book
    || path.startsWith('/api/delegation/')
    || /^\/api\/users(?:\/|$)/.test(path);

  return book || dashboard ? { book, dashboard } : null;
}

/**
 * Observe successful writes made through fetch, including older screens that
 * still have a small local request helper. App.tsx listens for this event and
 * revalidates only the snapshots affected by the write. No timer polls the
 * server and no page reload is involved.
 */
export function installLiveMutationBridge(target: Window = window): () => void {
  const originalFetch = target.fetch.bind(target);

  const wrappedFetch: typeof fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (!response.ok) return response;

    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
    if (READ_METHODS.has(method)) return response;

    let url: URL;
    try {
      url = new URL(isRequest ? input.url : String(input), target.location.origin);
    } catch {
      return response;
    }
    if (url.origin !== target.location.origin) return response;

    const impact = classifyLiveMutation(url.pathname, method);
    if (impact) {
      const detail: LiveMutationDetail = {
        ...impact,
        path: url.pathname,
        method,
        at: Date.now(),
      };
      target.dispatchEvent(new CustomEvent<LiveMutationDetail>(LIVE_MUTATION_EVENT, { detail }));
    }
    return response;
  };

  target.fetch = wrappedFetch;
  return () => {
    if (target.fetch === wrappedFetch) target.fetch = originalFetch;
  };
}

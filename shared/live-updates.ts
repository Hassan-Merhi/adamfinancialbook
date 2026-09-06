export interface LiveMutationImpact {
  book: boolean;
  dashboard: boolean;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Which shared client snapshots can be made stale by one successful API write. */
export function classifyLiveMutation(path: string, method: string): LiveMutationImpact | null {
  const verb = method.toUpperCase();
  if (READ_METHODS.has(verb) || !path.startsWith('/api/')) return null;

  // Authentication/security actions manage their own session state and do not
  // alter financial or delegation snapshots.
  if (
    path === '/api/login'
    || path === '/api/logout'
    || path === '/api/first-owner'
    || path === '/api/password'
    || path.startsWith('/api/security/')
    || path === '/api/security'
  ) return null;

  const coreBookWrite =
    path === '/api/reset-book'
    || /^\/api\/(?:entries|businesses|accounts|projects|people|loans|reminders)(?:\/|$)/.test(path);

  const delegatedBookWrite =
    /^\/api\/delegation\/transfers\/[^/]+\/confirm$/.test(path)
    || path === '/api/delegation/expense-reviews/assign';

  const book = coreBookWrite || delegatedBookWrite;
  const dashboard = book || path.startsWith('/api/delegation/') || /^\/api\/users(?:\/|$)/.test(path);
  return book || dashboard ? { book, dashboard } : null;
}

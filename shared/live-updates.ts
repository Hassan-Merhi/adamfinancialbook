export interface LiveMutationImpact {
  book: boolean;
  dashboard: boolean;
}

export type LiveTopic = 'approvals' | 'access' | 'files' | 'history';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function ignoredWrite(path: string): boolean {
  return path === '/api/login'
    || path === '/api/logout'
    || path === '/api/first-owner'
    || path === '/api/password'
    || path.startsWith('/api/security/')
    || path === '/api/security';
}

/** Which shared client snapshots can be made stale by one successful API write. */
export function classifyLiveMutation(path: string, method: string): LiveMutationImpact | null {
  const verb = method.toUpperCase();
  if (READ_METHODS.has(verb) || !path.startsWith('/api/')) return null;

  // Authentication/security actions manage their own session state and do not
  // alter financial or delegation snapshots.
  if (ignoredWrite(path)) return null;

  const accountAssignment = /^\/api\/delegation\/users\/[^/]+\/accounts$/.test(path);
  const coreBookWrite =
    path === '/api/reset-book'
    || /^\/api\/(?:entries|businesses|accounts|projects|people|loans|reminders)(?:\/|$)/.test(path);

  const delegatedBookWrite =
    accountAssignment
    || /^\/api\/delegation\/transfers\/[^/]+\/confirm$/.test(path)
    || path === '/api/delegation/expense-reviews/assign';

  const book = coreBookWrite || delegatedBookWrite;
  const dashboard = book || path.startsWith('/api/delegation/') || /^\/api\/users(?:\/|$)/.test(path);
  return book || dashboard ? { book, dashboard } : null;
}

/**
 * Phase 4 topic routing for pages that own data outside the shared overview.
 * Topics carry no ids, values, names or permissions: they only tell an already
 * authorized client which of its own GET snapshots should be revalidated.
 */
export function classifyLiveTopics(path: string, method: string): LiveTopic[] {
  const impact = classifyLiveMutation(path, method);
  if (!impact) return [];

  const topics = new Set<LiveTopic>();

  // The approvals / delegated-wallet page is backed by delegation/dashboard,
  // which also contains assigned-account balances and recent wallet activity.
  if (impact.dashboard) topics.add('approvals');

  const accountAssignment = /^\/api\/delegation\/users\/[^/]+\/accounts$/.test(path);
  if (
    path === '/api/reset-book'
    || accountAssignment
    || /^\/api\/users(?:\/|$)/.test(path)
    || /^\/api\/accounts(?:\/|$)/.test(path)
  ) topics.add('access');

  if (
    path === '/api/reset-book'
    || /^\/api\/delegation\/attachments(?:\/|$)/.test(path)
  ) topics.add('files');

  // Every propagated mutation can add an audit line. Keeping History scoped to
  // this topic means it refreshes only while that page is actually mounted.
  topics.add('history');

  return [...topics];
}

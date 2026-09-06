import {
  classifyLiveMutation,
  classifyLiveTopics,
  type LiveMutationImpact,
  type LiveTopic,
} from '../../shared/live-updates';

export { classifyLiveMutation, classifyLiveTopics } from '../../shared/live-updates';
export type { LiveMutationImpact, LiveTopic } from '../../shared/live-updates';

export const LIVE_MUTATION_EVENT = 'book:live-mutation';

export interface LiveMutationDetail extends LiveMutationImpact {
  topics: LiveTopic[];
  path: string;
  method: string;
  at: number;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CLIENT_KEY = 'book.live-client';

function liveClientId(target: Window): string {
  try {
    const kept = target.sessionStorage.getItem(CLIENT_KEY);
    if (kept) return kept;
    const made = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `live_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    target.sessionStorage.setItem(CLIENT_KEY, made);
    return made;
  } catch {
    return `live_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

function topicsFromRemote(payload: LiveMutationImpact & { topics?: unknown }): LiveTopic[] {
  if (Array.isArray(payload.topics)) {
    return payload.topics.filter((topic): topic is LiveTopic =>
      topic === 'approvals' || topic === 'access' || topic === 'files' || topic === 'history');
  }
  if (!payload.book && !payload.dashboard) return [];
  // Compatibility with a Phase 3 server during a rolling deploy. Correctness
  // wins over a few temporary extra reads; Phase 4 servers send precise topics.
  return ['approvals', 'access', 'files', 'history'];
}

/**
 * Observe successful local writes and subscribe to authenticated server push.
 * The server uses PostgreSQL NOTIFY + SSE, so a write on another phone/browser
 * reaches this tab without polling. This tab's id is attached to its writes so
 * its own server echo can be skipped.
 */
export function installLiveMutationBridge(target: Window = window): () => void {
  const originalFetch = target.fetch.bind(target);
  const clientId = liveClientId(target);
  let source: EventSource | null = null;

  const dispatch = (detail: LiveMutationDetail) => {
    target.dispatchEvent(new CustomEvent<LiveMutationDetail>(LIVE_MUTATION_EVENT, { detail }));
  };

  const stopRealtime = () => {
    source?.close();
    source = null;
  };

  const startRealtime = () => {
    if (source || typeof EventSource === 'undefined' || !target.navigator.onLine) return;
    const next = new EventSource(`/api/live-updates?client=${encodeURIComponent(clientId)}`);
    next.addEventListener('mutation', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as LiveMutationImpact & { topics?: unknown; at?: number };
        if (typeof payload.book !== 'boolean' || typeof payload.dashboard !== 'boolean') return;
        dispatch({
          book: payload.book,
          dashboard: payload.dashboard,
          topics: topicsFromRemote(payload),
          path: '/api/live-updates',
          method: 'REMOTE',
          at: typeof payload.at === 'number' ? payload.at : Date.now(),
        });
      } catch { /* malformed events are ignored */ }
    });
    source = next;
  };

  const wrappedFetch: typeof fetch = async (input, init) => {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
    let url: URL | null = null;
    try {
      url = new URL(isRequest ? input.url : String(input), target.location.origin);
    } catch { /* non-URL fetch input */ }

    const sameOrigin = url?.origin === target.location.origin;
    let nextInit = init;
    if (sameOrigin && !READ_METHODS.has(method)) {
      const headers = new Headers(isRequest ? input.headers : init?.headers);
      headers.set('x-live-client', clientId);
      nextInit = { ...init, headers };
    }

    const response = await originalFetch(input, nextInit);
    if (!response.ok || !sameOrigin || !url) return response;

    // Overview is only reachable after authentication and is loaded on every
    // signed-in startup, making it the safe point to open the live stream.
    if (method === 'GET' && url.pathname === '/api/overview') startRealtime();
    if (url.pathname === '/api/logout' && method !== 'GET') stopRealtime();

    if (READ_METHODS.has(method)) return response;
    const impact = classifyLiveMutation(url.pathname, method);
    if (impact) {
      dispatch({
        ...impact,
        topics: classifyLiveTopics(url.pathname, method),
        path: url.pathname,
        method,
        at: Date.now(),
      });
    }
    return response;
  };

  target.fetch = wrappedFetch;
  target.addEventListener('online', startRealtime);
  target.addEventListener('offline', stopRealtime);

  return () => {
    stopRealtime();
    target.removeEventListener('online', startRealtime);
    target.removeEventListener('offline', stopRealtime);
    if (target.fetch === wrappedFetch) target.fetch = originalFetch;
  };
}

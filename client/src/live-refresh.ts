import {
  classifyLiveMutation,
  classifyLiveTopics,
  type LiveMutationImpact,
  type LiveTopic,
} from '../../shared/live-updates';
import {
  dispatchLiveRecovery,
  LiveGapTracker,
  type LiveRecoveryReason,
} from './live-recovery';

export { classifyLiveMutation, classifyLiveTopics } from '../../shared/live-updates';
export type { LiveMutationImpact, LiveTopic } from '../../shared/live-updates';

export const LIVE_MUTATION_EVENT = 'book:live-mutation';
export const ALL_LIVE_TOPICS: readonly LiveTopic[] = ['approvals', 'access', 'files', 'history'];

export interface LiveMutationDetail extends LiveMutationImpact {
  topics: LiveTopic[];
  path: string;
  method: string;
  at: number;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LIVE_TAB_CHANNEL = 'book:live-tab-mutations';

/**
 * One id per loaded page, never per browser session.
 *
 * sessionStorage is intentionally not used here. Browsers can clone
 * sessionStorage when a tab is duplicated/opened from another tab, which used
 * to make several tabs share one live id. The server correctly suppresses the
 * initiating client's SSE echo; with a cloned id it could therefore suppress
 * that same transaction for sibling tabs too, leaving them stale until a
 * manual refresh. A fresh id per page means only the actual source tab is
 * skipped while every other open client receives the background update.
 */
export function createLiveClientId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `live_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function topicsFromRemote(payload: LiveMutationImpact & { topics?: unknown }): LiveTopic[] {
  if (Array.isArray(payload.topics)) {
    return payload.topics.filter((topic): topic is LiveTopic => ALL_LIVE_TOPICS.includes(topic as LiveTopic));
  }
  if (!payload.book && !payload.dashboard) return [];
  // Compatibility with a Phase 3 server during a rolling deploy. Correctness
  // wins over a few temporary extra reads; Phase 4+ servers send precise topics.
  return [...ALL_LIVE_TOPICS];
}

function validTabMutation(value: unknown): value is LiveMutationDetail {
  if (!value || typeof value !== 'object') return false;
  const detail = value as Partial<LiveMutationDetail>;
  return typeof detail.book === 'boolean'
    && typeof detail.dashboard === 'boolean'
    && typeof detail.path === 'string'
    && typeof detail.method === 'string'
    && typeof detail.at === 'number'
    && Number.isFinite(detail.at)
    && Array.isArray(detail.topics)
    && detail.topics.every((topic) => ALL_LIVE_TOPICS.includes(topic as LiveTopic));
}

/** Parse the value-free Phase 6 session-control event. */
export function parseLiveSessionRefresh(data: string, fallbackAt = Date.now()): number | null {
  try {
    const value = JSON.parse(data) as { state?: unknown; at?: unknown };
    if (value.state !== 'refresh') return null;
    return typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : fallbackAt;
  } catch {
    return null;
  }
}

/**
 * Observe successful local writes and subscribe to authenticated server push.
 * The server uses PostgreSQL NOTIFY + SSE, so a write on another phone/browser
 * reaches this tab without polling. This tab's id is attached to its writes so
 * its own server echo can be skipped.
 *
 * A BroadcastChannel mirrors successful writes to sibling tabs in the same
 * browser as an immediate second path. That keeps every visible statement and
 * balance current even while one tab's SSE connection is briefly reconnecting;
 * cross-device updates continue to come from PostgreSQL NOTIFY + SSE.
 *
 * Phase 5 adds gap recovery. PostgreSQL NOTIFY is deliberately ephemeral, so a
 * device that was offline, background-suspended, or temporarily disconnected
 * does one authoritative revalidation after the gap instead of pretending it
 * can replay notifications it never received.
 *
 * Phase 6 also lets the server terminate a stream whose durable security session
 * was revoked. The browser closes EventSource before revalidating, so an invalid
 * cookie signs out cleanly while a same-browser credential/role change can use
 * its newly issued cookie and reconnect under the new authority.
 */
export function installLiveMutationBridge(target: Window = window): () => void {
  const originalFetch = target.fetch.bind(target);
  const clientId = createLiveClientId();
  const gaps = new LiveGapTracker();
  let source: EventSource | null = null;
  let tabChannel: BroadcastChannel | null = null;

  const dispatch = (detail: LiveMutationDetail) => {
    target.dispatchEvent(new CustomEvent<LiveMutationDetail>(LIVE_MUTATION_EVENT, { detail }));
  };

  // Same-browser tabs should not have to wait for the server round trip to know
  // their own authorized snapshots are stale. Do not rebroadcast messages
  // received here, otherwise tabs would echo them in a loop.
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      tabChannel = new BroadcastChannel(LIVE_TAB_CHANNEL);
      tabChannel.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (validTabMutation(event.data)) dispatch(event.data);
      });
    } catch {
      tabChannel = null;
    }
  }

  const dispatchLocal = (detail: LiveMutationDetail) => {
    dispatch(detail);
    try { tabChannel?.postMessage(detail); } catch { /* SSE remains authoritative */ }
  };

  const recover = (reason: LiveRecoveryReason, at = Date.now()) => {
    // Keep a dedicated lifecycle signal for diagnostics/tests, then route the
    // actual catch-up through the same mutation invalidation system as Phases
    // 1-4. App.tsx already flushes the offline outbox on `online`; if that flush
    // is still running, its successful writes emit newer mutation events and
    // the existing refresh-start timestamps suppress stale duplicate reads.
    dispatchLiveRecovery(target, reason, at);
    dispatch({
      book: true,
      dashboard: true,
      topics: [...ALL_LIVE_TOPICS],
      path: '/api/live-updates/recovery',
      method: 'RECOVER',
      at,
    });
  };

  const stopRealtime = () => {
    source?.close();
    source = null;
  };

  const startRealtime = () => {
    if (source || typeof EventSource === 'undefined' || !target.navigator.onLine) return;
    const next = new EventSource(`/api/live-updates?client=${encodeURIComponent(clientId)}`);

    next.addEventListener('open', () => {
      const recovery = gaps.streamOpen();
      if (recovery) recover(recovery);
    });

    next.addEventListener('error', () => {
      gaps.streamError();
      // EventSource normally reconnects itself. If the browser declares this
      // source permanently closed, let a later online/resume/overview action
      // create a fresh one without introducing a retry polling loop here.
      if (next.readyState === EventSource.CLOSED && source === next) source = null;
    });

    next.addEventListener('session', (event) => {
      const at = parseLiveSessionRefresh((event as MessageEvent<string>).data);
      if (at == null) return;
      // Server-side session control is authoritative. Prevent EventSource from
      // retrying a now-invalid stream; the following overview revalidation will
      // either reconnect with the browser's newly issued cookie or move App to
      // signed-out state on 401.
      next.close();
      if (source === next) source = null;
      dispatch({
        book: true,
        dashboard: true,
        topics: [...ALL_LIVE_TOPICS],
        path: '/api/live-updates/session',
        method: 'SESSION',
        at,
      });
    });

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

    let response: Response;
    try {
      response = await originalFetch(input, nextInit);
    } catch (error) {
      // navigator.onLine can remain true through Wi-Fi captive portals, Render
      // restarts, DNS failures, and brief server/network outages. If startup's
      // auth/book read cannot reach the server, let EventSource keep attempting
      // its native reconnect; its later successful open becomes the catch-up
      // signal. This is transport recovery, not an application polling loop.
      if (
        sameOrigin
        && target.navigator.onLine
        && (url?.pathname === '/api/me' || url?.pathname === '/api/overview')
      ) {
        gaps.streamError();
        startRealtime();
      }
      throw error;
    }
    if (!response.ok || !sameOrigin || !url) return response;

    // Overview is only reachable after authentication and is loaded on every
    // signed-in startup, making it the normal safe point to open the live stream.
    if (method === 'GET' && url.pathname === '/api/overview') startRealtime();
    if (url.pathname === '/api/logout' && method !== 'GET') stopRealtime();

    if (READ_METHODS.has(method)) return response;
    const impact = classifyLiveMutation(url.pathname, method);
    if (impact) {
      dispatchLocal({
        ...impact,
        topics: classifyLiveTopics(url.pathname, method),
        path: url.pathname,
        method,
        at: Date.now(),
      });
    }
    return response;
  };

  const online = () => {
    // Try an immediate authoritative catch-up. If connectivity is only nominal
    // and the server still cannot be reached, EventSource will mark a gap and a
    // later successful `open` will trigger another recovery without polling.
    recover(gaps.online());
    startRealtime();
  };
  const offline = () => {
    gaps.offline();
    stopRealtime();
  };
  const visibility = () => {
    const now = Date.now();
    if (target.document.visibilityState === 'hidden') {
      gaps.hidden(now);
      return;
    }
    const recovery = gaps.visible(now);
    if (recovery && target.navigator.onLine) {
      recover(recovery, now);
      startRealtime();
    }
  };

  target.fetch = wrappedFetch;
  target.addEventListener('online', online);
  target.addEventListener('offline', offline);
  target.document.addEventListener('visibilitychange', visibility);

  return () => {
    stopRealtime();
    tabChannel?.close();
    tabChannel = null;
    target.removeEventListener('online', online);
    target.removeEventListener('offline', offline);
    target.document.removeEventListener('visibilitychange', visibility);
    if (target.fetch === wrappedFetch) target.fetch = originalFetch;
  };
}

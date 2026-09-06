import { useEffect, useRef, type MutableRefObject } from 'react';
import { LIVE_MUTATION_EVENT, type LiveMutationDetail, type LiveTopic } from './live-refresh';

export function liveEventMatches(detail: LiveMutationDetail | null | undefined, topics: readonly LiveTopic[]): boolean {
  if (!detail || !Array.isArray(detail.topics) || topics.length === 0) return false;
  return topics.some((topic) => detail.topics.includes(topic));
}

/**
 * Subscribe one mounted page to only the realtime datasets it owns.
 * Bursts are coalesced and a page can provide its last refresh-start ref so an
 * explicit local reload that already began after the mutation suppresses the
 * duplicate automatic read.
 */
export function useLiveTopics(
  topics: readonly LiveTopic[],
  refresh: () => void | Promise<void>,
  lastRefreshStarted?: MutableRefObject<number>,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const topicKey = [...topics].sort().join('|');

  useEffect(() => {
    const wanted = topicKey.split('|').filter(Boolean) as LiveTopic[];
    if (!wanted.length) return;

    let timer: number | null = null;
    let newestAt = 0;

    const changed = (event: Event) => {
      const detail = (event as CustomEvent<LiveMutationDetail>).detail;
      if (!liveEventMatches(detail, wanted)) return;
      newestAt = Math.max(newestAt, detail.at || Date.now());
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const mutationAt = newestAt;
        newestAt = 0;
        if (lastRefreshStarted && lastRefreshStarted.current >= mutationAt) return;
        void refreshRef.current();
      }, 180);
    };

    window.addEventListener(LIVE_MUTATION_EVENT, changed);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener(LIVE_MUTATION_EVENT, changed);
    };
  }, [topicKey, lastRefreshStarted]);
}

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { LIVE_MUTATION_EVENT, type LiveMutationDetail, type LiveTopic } from './live-refresh';

export function liveEventMatches(detail: LiveMutationDetail | null | undefined, topics: readonly LiveTopic[]): boolean {
  if (!detail || !Array.isArray(detail.topics) || topics.length === 0) return false;
  return topics.some((topic) => detail.topics.includes(topic));
}

function useTopicListener(
  topics: readonly LiveTopic[],
  onChange: (detail: LiveMutationDetail) => void,
): void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const topicKey = [...topics].sort().join('|');

  useEffect(() => {
    const wanted = topicKey.split('|').filter(Boolean) as LiveTopic[];
    if (!wanted.length) return;

    const changed = (event: Event) => {
      const detail = (event as CustomEvent<LiveMutationDetail>).detail;
      if (!liveEventMatches(detail, wanted)) return;
      onChangeRef.current(detail);
    };

    window.addEventListener(LIVE_MUTATION_EVENT, changed);
    return () => window.removeEventListener(LIVE_MUTATION_EVENT, changed);
  }, [topicKey]);
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
  const timer = useRef<number | null>(null);
  const newestAt = useRef(0);

  useTopicListener(topics, (detail) => {
    newestAt.current = Math.max(newestAt.current, detail.at || Date.now());
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const mutationAt = newestAt.current;
      newestAt.current = 0;
      if (lastRefreshStarted && lastRefreshStarted.current >= mutationAt) return;
      void refreshRef.current();
    }, 180);
  });

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
}

/**
 * Small wrapper helper for existing route-sized pages whose current loaders are
 * intentionally kept untouched. A matching live event remounts only that page
 * subtree, never the application shell, prompt, navigation, or other pages.
 */
export function useLiveRevision(
  topics: readonly LiveTopic[],
  shouldRefresh?: (detail: LiveMutationDetail) => boolean,
): number {
  const [revision, setRevision] = useState(0);
  const shouldRefreshRef = useRef(shouldRefresh);
  shouldRefreshRef.current = shouldRefresh;
  const timer = useRef<number | null>(null);

  useTopicListener(topics, (detail) => {
    if (shouldRefreshRef.current && !shouldRefreshRef.current(detail)) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setRevision((current) => current + 1);
    }, 180);
  });

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  return revision;
}

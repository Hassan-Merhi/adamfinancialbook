import type { Queued } from './offline-db';
import { isOfflineSetupInput, type OfflineSetupInput } from '../../shared/offline-setup';

export function queuedDependencies(item: Queued): string[] {
  if (!isOfflineSetupInput(item.input as unknown)) return [];
  const deps = (item.input as unknown as OfflineSetupInput).offlineDependsOn;
  return Array.isArray(deps) ? [...new Set(deps.filter((id) => typeof id === 'string' && !!id))] : [];
}

/**
 * Stable topological ordering for the outbox. Unrelated writes keep their
 * original relative order, while an explicitly named dependency always moves
 * ahead of its child even after IndexedDB reload/timestamp ties.
 */
export function orderQueuedByDependencies<T extends Queued>(queue: T[]): T[] {
  if (queue.length < 2) return [...queue];
  const pending = [...queue];
  const queueIds = new Set(pending.map((item) => item.id));
  const completed = new Set<string>();
  const ordered: T[] = [];

  while (pending.length) {
    const ready = pending.findIndex((item) =>
      queuedDependencies(item).every((dependency) => !queueIds.has(dependency) || completed.has(dependency)));
    if (ready < 0) {
      throw new Error('Offline setup dependency cycle detected. Review the queued setup changes before syncing.');
    }
    const [item] = pending.splice(ready, 1);
    ordered.push(item);
    completed.add(item.id);
  }
  return ordered;
}

export function queuedDependents(queue: Queued[], parentId: string): Queued[] {
  return queue.filter((item) => queuedDependencies(item).includes(parentId));
}

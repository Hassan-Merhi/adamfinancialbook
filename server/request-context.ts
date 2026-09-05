import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestActor {
  id: string;
  email: string;
}

const storage = new AsyncLocalStorage<RequestActor | null>();

export function runWithRequestActor<T>(actor: RequestActor | null, fn: () => T): T {
  return storage.run(actor, fn);
}

export function currentRequestActor(): RequestActor | null {
  return storage.getStore() ?? null;
}

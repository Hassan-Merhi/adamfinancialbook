/** Offline-safe creation payloads for non-destructive book setup. */
export type OfflineSetupType = 'business' | 'account' | 'project' | 'person' | 'reminder';

export type OfflineSetupDraft =
  | { setupType: 'business'; name: string }
  | { setupType: 'account'; name: string; businessId: string | null; opening: number }
  | { setupType: 'project'; name: string; businessId: string; opening: number; scope?: string }
  | { setupType: 'person'; name: string; businessId: string; kind: 'receivable' | 'payable' | 'salary'; opening: number; salary: number; role: string }
  | { setupType: 'reminder'; what: string; amount: number; accountId: string | null; note?: string };

export type OfflineSetupInput = (OfflineSetupDraft & {
  offlineOperation: 'setup_create';
  /** The durable outbox id. It is also the idempotency key for server replay. */
  clientRef?: string | null;
});

const PREFIX: Record<OfflineSetupType, string> = {
  business: 'biz',
  account: 'acc',
  project: 'prj',
  person: 'per',
  reminder: 'rem',
};

function token(clientRef: string | null | undefined): string {
  const clean = String(clientRef ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 70);
  if (!clean) throw new Error('Offline setup is missing its durable client reference.');
  return clean;
}

/**
 * The final PostgreSQL id is derivable before sync. That lets the projected UI
 * use the exact future server id without a fragile temp-id rewrite.
 */
export function offlineSetupEntityId(input: Pick<OfflineSetupInput, 'setupType' | 'clientRef'>): string {
  return `${PREFIX[input.setupType]}_${token(input.clientRef)}`;
}

export function offlineSetupReceiptId(clientRef: string | null | undefined): string {
  return `rcp_${token(clientRef)}`;
}

export function isOfflineSetupInput(value: unknown): value is OfflineSetupInput {
  if (!value || typeof value !== 'object') return false;
  const item = value as { offlineOperation?: unknown; setupType?: unknown };
  return item.offlineOperation === 'setup_create'
    && ['business', 'account', 'project', 'person', 'reminder'].includes(String(item.setupType));
}

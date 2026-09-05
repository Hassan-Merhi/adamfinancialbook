/** Everything the screens know about the server. */
import type { AuditLine, Book, Entry, EntryInput, ProjectReceipt } from '../../shared/types';
import type { Draft } from '../../shared/parse';

export interface Balances {
  totalCash: number;
  accounts: Record<string, number>;
  businesses: Record<string, number>;
  people: Record<string, number>;
  loans: Record<string, number>;
  projects: Record<string, number>;
}
export type LoadedBook = Book & { balances: Balances };

/** Thrown when an ordinary app request discovers that the session is gone. */
export class NotSignedIn extends Error {
  constructor() { super('Sign in to open the book.'); }
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-book': '1' },
    credentials: 'same-origin',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? safeParse(text) : null;
  const authAction = path === '/login' || path === '/security/reauth' || path === '/password';
  if (res.status === 401 && !authAction) throw new NotSignedIn();
  if (!res.ok) {
    const said = data?.error ?? (text ? text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '');
    throw new ApiError(said || `Request failed (${res.status})`, res.status, data?.code);
  }
  return data as T;
}

function safeParse(text: string) {
  try { return JSON.parse(text); } catch { return null; }
}

/** `email` is the legacy wire-field name; the product now presents it as username. */
export interface Me {
  user: { id: string; email: string; role: 'owner' | 'entry'; language?: 'en' | 'fr' | 'ar' } | null;
  needsFirstOwner: boolean;
}

export interface Keyholder {
  id: string;
  email: string;
  role: 'owner' | 'entry';
  active: boolean;
  createdAt: string;
  disabledAt: string | null;
  mfaEnabled: boolean;
  lastSeen: string | null;
}

export interface SecuritySessionView {
  id: string;
  current: boolean;
  createdAt: string;
  authenticatedAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  userAgent: string;
}

export interface SecurityState {
  mfaEnabled: boolean;
  recentlyAuthenticated: boolean;
  recentAuthExpiresAt: string | null;
  sessions: SecuritySessionView[];
}

export interface MfaSetup {
  secret: string;
  uri: string;
}

export interface Reading { draft: Draft; source: 'claude' | 'rules'; duplicate: ProjectReceipt | null }

export interface PendingTransferSave {
  mode: 'pending_transfer';
  id: string;
  status: 'pending';
}
export type EntrySaveResult = Entry | PendingTransferSave;

export interface EvidenceFile {
  id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  created_at: string;
}

export interface EvidenceApproval {
  id: string;
  request_text: string;
  amount: number | null;
  status: 'pending' | 'approved' | 'rejected';
  requester_email?: string;
  account_name?: string;
  review_note?: string;
  created_at: string;
}

export interface EvidencePendingTransfer {
  id: string;
  amount: number;
  purpose: string;
  from_account_id: string;
  to_account_id: string;
  from_account_name: string;
  to_account_name: string;
  recipient_email?: string;
  created_at: string;
}

export interface EvidenceNotification {
  id: string;
  type?: string;
  title: string;
  body: string;
  related_type?: string | null;
  related_id?: string | null;
  read_at: string | null;
  created_at: string;
}

export interface EvidenceActivity {
  id: string;
  occurred_on?: string;
  amount?: number;
  purpose?: string;
  kind?: string;
  actor_email?: string;
  account_name?: string;
  created_at?: string;
}

export interface DelegationAccount {
  id: string;
  name: string;
  businessId: string;
  opening: number;
  balance: number;
}

export interface DelegationDelegate {
  id: string;
  email: string;
  accountIds: string[];
}

export interface DelegatedExpenseReview {
  id: string;
  occurred_on: string;
  amount: number;
  purpose: string;
  raw: string;
  account_id: string;
  account_name: string;
  payer_business_id: string;
  payer_business_name: string;
  actor_email: string;
  created_at: string;
}

export interface EvidenceDashboard {
  mode: 'owner' | 'entry';
  accounts?: DelegationAccount[];
  delegates?: DelegationDelegate[];
  approvals: EvidenceApproval[];
  pendingTransfers: EvidencePendingTransfer[];
  recentActivity: EvidenceActivity[];
  notifications: EvidenceNotification[];
  expenseReviews: DelegatedExpenseReview[];
}

/**
 * The prompt uses the ordinary entry endpoint for every transaction. When the
 * destination is a delegated wallet, the server intentionally refuses a direct
 * ledger transfer. In that one case, turn the exact same confirmed draft into a
 * cash-handoff request so the recipient must confirm receipt before anything
 * posts to the ledger.
 */
async function addEntry(input: EntryInput): Promise<EntrySaveResult> {
  try {
    return await send<Entry>('/entries', 'POST', input);
  } catch (err) {
    const delegatedDestination = err instanceof Error
      && err.message.includes('belongs to a delegated user');
    if (input.kind !== 'transfer' || !input.accountId || !input.toAccountId || !delegatedDestination) {
      throw err;
    }

    const pending = await send<{ id: string; status: 'pending' }>('/delegation/transfers', 'POST', {
      fromAccountId: input.accountId,
      toAccountId: input.toAccountId,
      amount: input.amount,
      purpose: input.purpose || 'Cash handoff',
      occurredOn: input.occurredOn,
    });
    return { mode: 'pending_transfer', ...pending };
  }
}

function evidenceQuery(kind: 'entry' | 'request', id: string) {
  return send<{ files: EvidenceFile[] }>(
    `/delegation/attachments/${kind}/${encodeURIComponent(id)}`,
    'GET',
  );
}

async function uploadEvidence(entryId: string, file: File): Promise<void> {
  const res = await fetch(`/api/delegation/attachments/entry/${encodeURIComponent(entryId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-book': '1',
    },
    body: file,
  });
  const text = await res.text();
  const data = text ? safeParse(text) : null;
  if (res.status === 401) throw new NotSignedIn();
  if (!res.ok) throw new ApiError(data?.error || `Upload failed (${res.status})`, res.status, data?.code);
}

async function evidenceDashboard(): Promise<EvidenceDashboard> {
  const [dashboard, reviewQueue] = await Promise.all([
    send<Omit<EvidenceDashboard, 'expenseReviews'>>('/delegation/dashboard', 'GET'),
    send<{ items: DelegatedExpenseReview[] }>('/delegation/expense-reviews', 'GET'),
  ]);
  return { ...dashboard, expenseReviews: reviewQueue.items };
}

export const api = {
  me: () => send<Me>('/me', 'GET'),
  login: (username: string, password: string, totp?: string) => send<Me>('/login', 'POST', { username, password, totp }),
  firstOwner: (username: string, password: string) => send<Me>('/first-owner', 'POST', { username, password }),
  logout: () => send('/logout', 'POST'),
  book: () => send<LoadedBook>('/book', 'GET'),
  read: (text: string, today: string) => send<Reading>('/read', 'POST', { text, today }),
  addBusiness: (name: string) => send('/businesses', 'POST', { name }),
  addAccount: (b: { name: string; businessId?: string | null; opening: number }) => send('/accounts', 'POST', b),
  addProject: (b: { name: string; businessId: string; opening: number; scope?: string }) => send('/projects', 'POST', b),
  addPerson: (b: { name: string; businessId: string; kind: string; opening: number; salary: number; role: string }) =>
    send('/people', 'POST', b),
  setLoan: (b: { fromBusiness: string; toBusiness: string; opening: number }) => send('/loans', 'PUT', b),
  addEntry,
  addReminder: (b: { what: string; amount: number; accountId: string | null; note?: string }) =>
    send('/reminders', 'POST', b),
  clearReminder: (id: string) => send(`/reminders/${id}`, 'DELETE'),
  correct: (id: string, amount: number) => send(`/entries/${id}`, 'PATCH', { amount }),
  voidEntry: (id: string, reason: string) => send(`/entries/${id}/void`, 'POST', { reason }),
  history: () => send<{ lines: AuditLine[] }>('/history', 'GET'),
  users: () => send<{ users: Keyholder[]; suggestion: string }>('/users', 'GET'),
  addUser: (b: { username?: string; email?: string; password: string; role: string }) => send('/users', 'POST', b),
  setUsername: (id: string, username: string) => send(`/users/${id}/username`, 'POST', { username }),
  resetPassword: (id: string, password: string) => send(`/users/${id}/password`, 'POST', { password }),
  setRole: (id: string, role: string) => send(`/users/${id}/role`, 'POST', { role }),
  removeUser: (id: string) => send(`/users/${id}`, 'DELETE'),
  restoreUser: (id: string) => send(`/users/${id}/restore`, 'POST'),
  changePassword: (current: string, next: string) => send('/password', 'POST', { current, next }),
  security: () => send<SecurityState>('/security', 'GET'),
  reauthenticate: (password: string, totp?: string) =>
    send<{ ok: true; recentAuthSeconds: number }>('/security/reauth', 'POST', { password, totp }),
  setupMfa: () => send<MfaSetup>('/security/mfa/setup', 'POST'),
  enableMfa: (code: string) => send('/security/mfa/enable', 'POST', { code }),
  disableMfa: (code: string) => send('/security/mfa/disable', 'POST', { code }),
  revokeSession: (id: string) => send<{ ok: true; signedOut: boolean }>(`/security/sessions/${id}`, 'DELETE'),
  revokeAllSessions: () => send<{ ok: true; count: number; signedOut: boolean }>('/security/sessions/revoke-all', 'POST'),
  resetBook: (password: string, confirmation: 'RESET') => send('/reset-book', 'POST', { password, confirmation }),
  evidenceDashboard,
  setUserAccounts: (id: string, accountIds: string[]) =>
    send(`/delegation/users/${encodeURIComponent(id)}/accounts`, 'PUT', { accountIds }),
  evidenceForEntry: (entryId: string) => evidenceQuery('entry', entryId),
  evidenceForRequest: (requestId: string) => evidenceQuery('request', requestId),
  uploadEvidence,
  confirmTransfer: (id: string) => send(`/delegation/transfers/${id}/confirm`, 'POST'),
  rejectTransfer: (id: string) => send(`/delegation/transfers/${id}/reject`, 'POST'),
  decideApproval: (id: string, status: 'approved' | 'rejected', note = '') =>
    send(`/delegation/approvals/${id}/decision`, 'POST', { status, note }),
  assignExpenseReviews: (entryIds: string[], businessId: string, projectId: string | null, category = '') =>
    send<{ ok: true; count: number }>('/delegation/expense-reviews/assign', 'POST', {
      entryIds, businessId, projectId, category,
    }),
  markNotificationRead: (id: string) => send(`/delegation/notifications/${id}/read`, 'POST'),
  markAllNotificationsRead: () => send('/delegation/notifications/read-all', 'POST'),
  evidenceUrl: (id: string) => `/api/delegation/attachments/${encodeURIComponent(id)}`,
};
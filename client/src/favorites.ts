const MAX_PINNED_ACCOUNTS = 8;

export const PINNED_ACCOUNTS_KEY = 'book.pinned-accounts.v1';

export function normalizePinnedAccounts(ids: string[], validIds: Iterable<string>): string[] {
  const valid = new Set(validIds);
  return [...new Set(ids)].filter((id) => valid.has(id)).slice(0, MAX_PINNED_ACCOUNTS);
}

export function togglePinnedAccount(ids: string[], id: string, validIds: Iterable<string>): string[] {
  const current = normalizePinnedAccounts(ids, validIds);
  return current.includes(id)
    ? current.filter((item) => item !== id)
    : normalizePinnedAccounts([id, ...current], validIds);
}

export function loadPinnedAccounts(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(PINNED_ACCOUNTS_KEY) || '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function savePinnedAccounts(ids: string[]) {
  try { localStorage.setItem(PINNED_ACCOUNTS_KEY, JSON.stringify(ids)); }
  catch { /* private mode: pins simply last for this session */ }
}

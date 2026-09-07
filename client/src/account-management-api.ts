async function accountRequest(path: string, method: 'PATCH' | 'DELETE', body?: unknown): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-book': '1' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: { error?: string } | null = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-json error body */ }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
}

export function updateAccount(id: string, input: { name: string; opening: number }) {
  return accountRequest(`/accounts/${encodeURIComponent(id)}`, 'PATCH', input);
}

export function deleteAccount(id: string) {
  return accountRequest(`/accounts/${encodeURIComponent(id)}`, 'DELETE');
}

import { lastUser } from './offline';

const CREDENTIAL_CHECK_401_PATHS = new Set([
  '/api/login',
  '/api/security/reauth',
  '/api/password',
]);

/**
 * A real protected-endpoint 401 means the server no longer accepts this device's
 * session. Once that fact is known, the cached offline identity must not be able
 * to reopen the book later with no network. Wrong-password credential checks are
 * excluded because they do not invalidate an otherwise healthy session.
 */
export function shouldQuarantineOfflineIdentity(path: string, status: number): boolean {
  return status === 401
    && path.startsWith('/api/')
    && !CREDENTIAL_CHECK_401_PATHS.has(path);
}

export function installSessionQuarantine(target: Window = window): () => void {
  const previousFetch = target.fetch.bind(target);

  const wrappedFetch: typeof fetch = async (input, init) => {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    let url: URL | null = null;
    try {
      url = new URL(isRequest ? input.url : String(input), target.location.origin);
    } catch { /* leave non-URL requests untouched */ }

    const response = await previousFetch(input, init);
    if (
      url?.origin === target.location.origin
      && shouldQuarantineOfflineIdentity(url.pathname, response.status)
    ) {
      // clearSession removes the active profile + cached snapshot but preserves
      // the per-user outbox/attachments, so revocation cannot expose cached data
      // and unsent financial work is not destroyed.
      await lastUser.clear();
    }
    return response;
  };

  target.fetch = wrappedFetch;
  return () => {
    if (target.fetch === wrappedFetch) target.fetch = previousFetch;
  };
}

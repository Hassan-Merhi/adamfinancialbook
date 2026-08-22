/**
 * Enough service worker to open with no signal.
 *
 * The app shell is cached as it is used, and served from the cache when the
 * network is unreachable. API calls are never cached — the book's figures come
 * from the snapshot the app itself keeps, so nothing stale is ever presented as
 * if it were live.
 */
const CACHE = 'book-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/index.html'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api')) return;   // the book is never served from a cache

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
        return response;
      })
      .catch(async () => (await caches.match(request)) ?? caches.match('/index.html')),
  );
});

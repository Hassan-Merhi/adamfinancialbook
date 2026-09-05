/**
 * Offline shell + fast repeat launches.
 *
 * API calls are never cached. Vite's hashed /assets/* files are safe to serve
 * cache-first because a new build gets a new filename; navigation remains
 * network-first so users receive the newest index whenever a connection exists.
 */
const CACHE = 'book-shell-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api')) return;

  if (url.pathname.startsWith('/assets/')) {
    const update = fetch(request).then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    });
    event.respondWith(
      caches.match(request).then((cached) => cached ?? update).catch(() => caches.match(request)),
    );
    event.waitUntil(update.then(() => undefined).catch(() => undefined));
    return;
  }

  event.respondWith(
    fetch(request)
      .then(async (response) => {
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(request, response.clone());
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') return (await caches.match('/index.html')) ?? Response.error();
        return Response.error();
      }),
  );
});

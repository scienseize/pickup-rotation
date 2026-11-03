// Network first for the app's own files, falling back to the last copy, so the
// page still opens with no connection. API calls are never cached.
const CACHE = 'pickup-v1';
const FILES = ['./', 'app.js', 'queue.js', 'names.js']; // not index.html: Cloudflare redirects it to /

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request)
    .then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('./'))));
});

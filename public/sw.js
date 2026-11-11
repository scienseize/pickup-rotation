// Network first for the app's own files, falling back to the last copy, so the
// page still opens with no connection. API calls are never cached.
// A redirect (to the sign-in page, when this device's session has run out) is never
// cached either, so it can't replace the stored app. Sign out deletes this cache.
const CACHE = 'pickup-v5';
// 'app' is the app (app.html, served at /app). The sign-in page at / is not kept: a signed-in
// device is redirected from it, and offline any page falls back to the app.
const FILES = ['app', 'app.js', 'theme.js', 'queue.js', 'names.js', 'logo.png', 'favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request)
    .then(res => {
      if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('app'))));
});

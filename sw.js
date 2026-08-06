// TopFlowNG Service Worker v3
// Network-first for every /api/ request (never cached — tokens and private
// responses are never stored). Shell-first for navigations; cache-first for
// static assets. skipWaiting + clients.claim mean a new version takes over on
// the next load — no stale-asset trap.
const CACHE = 'topflowng-v3';
const STATIC = [
  '/',
  '/topflowng.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Only same-origin requests are managed here; cross-origin (fonts, Paystack,
  // AdSense) are passed straight through so we never touch third-party data.
  if (url.origin !== self.location.origin) return;

  // Always network-first for API calls. NEVER cache — responses may contain
  // wallet balances, tokens, or private data.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(() => new Response('{"error":"Offline"}', { headers: { 'Content-Type': 'application/json' }, status: 503 })));
    return;
  }

  // Private/developer routes are never served from cache.
  if (
    url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml' ||
    url.pathname === '/admin.html' || url.pathname === '/bizflow.html'
  ) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Serve shell from cache for navigations
  if (e.request.mode === 'navigate') {
    e.respondWith(
      caches.match('/topflowng.html').then(r => r || fetch(e.request))
    );
    return;
  }

  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res && res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }))
  );
});

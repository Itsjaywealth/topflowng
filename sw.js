// TopFlowNG Service Worker v8
// Network-first for every /api/ request (never cached — tokens and private
// responses are never stored). Navigations are network-only so a previously
// cached app shell can never hide a deployment.
// Cache-first for immutable static assets only. skipWaiting + clients.claim
// mean a new version takes over on the next load — no stale-asset trap.
const CACHE = 'topflowng-v9';
const STATIC = [
  '/icons/icon-192.png?v=2',
  '/icons/icon-512.png?v=2',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/icons/favicon-16.png',
  '/assets/brand/topflowng-mark.svg',
  '/assets/provider-logos.js',
  '/assets/providers/mtn.svg',
  '/assets/providers/glo.png',
  '/assets/providers/airtel.png',
  '/assets/providers/t2.png',
  '/assets/providers/9mobile.webp',
  '/assets/providers/ikedc.png',
  '/assets/providers/ekedc.png',
  '/assets/providers/aedc.png',
  '/assets/providers/phedc.jpg',
  '/assets/providers/kedc.png',
  '/assets/providers/ibedc.png',
  '/assets/providers/jed.png',
  '/assets/providers/kaedco.png',
  '/assets/providers/eedc.png',
  '/assets/providers/bedc.png',
  '/assets/providers/aple.png',
  '/assets/providers/yedc.png',
  '/assets/providers/dstv.png',
  '/assets/providers/gotv.png',
  '/assets/providers/startimes.png',
  '/assets/providers/waec.png',
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

  // Never cache or fall back for page navigations. An installed PWA must show
  // the current server-rendered shell on every successful load.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request));
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

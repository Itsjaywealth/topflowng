// TopFlowNG Service Worker v10
// Network-first for every /api/ request (never cached). Navigations are
// network-only. Cache-first for immutable static assets. Push notifications
// for purchase confirmations. skipWaiting + clients.claim for instant updates.
const CACHE = 'topflowng-v10';
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
  '/public/blog/index.html',
  '/public/blog/how-to-buy-mtn-data.html',
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
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(() => new Response('{"error":"Offline"}', { headers: { 'Content-Type': 'application/json' }, status: 503 })));
    return;
  }

  if (
    url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml' ||
    url.pathname === '/admin.html' || url.pathname === '/bizflow.html'
  ) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request));
    return;
  }

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

// Push notification support
self.addEventListener('push', e => {
  if (!e.data) return;
  try {
    const data = e.data.json();
    const title = data.title || 'TopFlowNG';
    const options = {
      body: data.body || '',
      icon: '/icons/icon-192.png?v=2',
      badge: '/icons/favicon-32.png',
      data: { url: data.url || '/' },
    };
    e.waitUntil(self.registration.showNotification(title, options));
  } catch {}
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(clients.openWindow(url));
});
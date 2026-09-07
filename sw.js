/* Health Tracker service worker.
 *
 * Same load architecture as the Finance and Mio trackers (see
 * 04_FINANCIAL_TRACKER_REFERENCE.md "Load Architecture"): the app shell is served
 * stale-while-revalidate so a cold start paints from cache immediately instead of
 * blocking on a slow mobile link, and the cache is refreshed in the background for
 * the next launch. That pattern is what took those two apps from a 20-30s iPhone
 * cold start to roughly instant.
 *
 * Bump CACHE on every deploy. Expect 2-3 cold opens before a new worker installs
 * and repopulates.
 */
const CACHE = 'health-tracker-v4';

// index.html is deliberately NOT precached here. The fetch handler keeps a fresh
// copy on every successful load, so an online user never gets stale code while an
// offline user still gets a working shell.
const ASSETS = [
  './manifest.json',
  './engine.js',
  './icon/icon-192.png',
  './icon/icon-512.png',
  './icon/icon-maskable-512.png',
  './icon/apple-touch-icon-180.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll is all-or-nothing; a single CDN hiccup would abort the whole
      // install and leave the app uncached, so each asset is added on its own.
      .then(c => Promise.all(ASSETS.map(a => c.add(a).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = req.url;

  if (req.method !== 'GET') return;

  // App shell: stale-while-revalidate.
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match('./index.html').then(cached => {
          const network = fetch(req).then(res => {
            if (res && res.ok) cache.put('./index.html', res.clone());
            return res;
          }).catch(() => cached || cache.match('./'));
          return cached || network;
        })
      )
    );
    return;
  }

  // Drive / auth / API calls always go to the network. Serving a stale health
  // payload would be worse than showing nothing.
  if (url.includes('workers.dev') || url.includes('googleapis.com') ||
      url.includes('accounts.google.com')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Everything else (Chart.js, icons, engine.js): cache-first.
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (res.ok) {
        const clone = res.clone();
        e.waitUntil(caches.open(CACHE).then(c => c.put(req, clone)));
      }
      return res;
    }))
  );
});

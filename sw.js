// Bump CACHE whenever the HTML / JS shape changes so the activate event
// drops the old cache and users pick up the new shell on next load.
const CACHE = 'omarchy-themes-v19';
const CACHEABLE = /\.(jpe?g|png|webp|gif|json|html|css|js|toml|lua)$/i;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// HTML + JS / JSON: network-first so a new deploy is picked up
// immediately. Images / toml / lua: cache-first (they're immutable on
// the CDN side and form the bulk of bytes the site uses).
const NETWORK_FIRST = /\.(html|js|json)$/i;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('range')) return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const isHtmlNavigation = req.mode === 'navigate'
    || (req.destination === 'document');
  const path = url.pathname;
  const cacheable = CACHEABLE.test(path) || isHtmlNavigation;
  if (!cacheable) return;

  const useNetworkFirst = isHtmlNavigation || NETWORK_FIRST.test(path);

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);

    if (useNetworkFirst) {
      try {
        const res = await fetch(req);
        if (res.ok && res.status === 200) cache.put(req, res.clone());
        return res;
      } catch (err) {
        const cached = await cache.match(req);
        if (cached) return cached;
        throw err;
      }
    }

    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok && res.status === 200) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const fallback = await cache.match(req);
      if (fallback) return fallback;
      throw err;
    }
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'clear-cache') {
    caches.delete(CACHE).then(() => e.source && e.source.postMessage('cache-cleared'));
  }
});

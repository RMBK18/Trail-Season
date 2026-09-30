// ─────────────────────────────────────────────────────────────
// Fall Hike App service worker
// Precaches the whole app on first visit, so it opens with no signal.
//
// After ANY change to the files below (hike data, styles, code, icons):
// bump VERSION. Installed phones pick up the new version the next time
// they open the app with a connection.
// ─────────────────────────────────────────────────────────────

const VERSION = 'fall-hike-2026-10-v15';

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/ask.js',
  './js/config.js',
  './js/data.js',
  './js/icons.js',
  './js/lib.js',
  './js/rsvp.js',
  './js/admin.js',
  './js/editor.js',
  './js/weather.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './img/hikes/season.jpg',
  './img/hikes/forks-of-the-credit.jpg',
  './img/hikes/dundas-valley.jpg',
  './img/hikes/rattlesnake-point.jpg',
  './img/hikes/balls-falls.jpg',
  './img/hikes/short-hills.jpg',
  './fonts/dm-sans.woff2',
  './fonts/libre-baskerville.woff2',
  './fonts/libre-baskerville-italic.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // Phase 2 POSTs (AI, RSVP) go straight to the network
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Maps, booking sites, Firebase: not cached

  // Page loads (any path or hash inside the app): serve the cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html', { cacheName: VERSION })
        .then((cached) => cached || fetch(req))
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  // Everything else: cache first, then network (and keep a copy).
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    }),
  );
});

// ─────────────────────────────────────────────────────────────
// Fall Hike App service worker
// Precaches the whole app on first visit, so it opens with no signal.
//
// After ANY change to the files below (hike data, styles, code, icons):
// bump VERSION. Installed phones pick up the new version the next time
// they open the app with a connection.
// ─────────────────────────────────────────────────────────────

const VERSION = 'fall-hike-2026-10-v21';

// The app shell is cached as './', never './index.html': Cloudflare Pages
// redirects /index.html to /, and Chrome won't open a page from a redirected
// response ("This site can't be reached").
const SHELL = './';

const ASSETS = [
  SHELL,
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/ask.js',
  './js/carpool.js',
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
  './img/hikes/rouge.jpg',
  './fonts/dm-sans.woff2',
  './fonts/libre-baskerville.woff2',
  './fonts/libre-baskerville-italic.woff2',
];

// Copy a redirected response into a plain one, so it can answer a page load.
const unredirect = (res) => (res && res.redirected
  ? res.blob().then((body) => new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers }))
  : res);

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
      caches.match(SHELL, { cacheName: VERSION })
        .then((cached) => (cached ? unredirect(cached) : fetch(req)))
        .catch(() => caches.match(SHELL).then(unredirect)),
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

// ── Notifications (ride requests, plan updates) ─────────────
// The app's two notifications: ride requests for drivers ("🚗 Sara (Downtown)
// wants a ride with you") and the organizer's plan updates ("📣 Update from
// Summan"). Tapping one opens the hike's Rides or updates.
self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch { /* not JSON: show the plain title */ }
  event.waitUntil(
    self.registration.showNotification(msg.title || 'Fall Hike App', {
      body: msg.body || '',
      icon: './icons/icon-192.png',
      tag: msg.tag || 'ride',
      renotify: true,
      data: { url: msg.url || './' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (wins) => {
      const win = wins.find((w) => w.url.startsWith(self.registration.scope));
      if (win) {
        await win.focus();
        // Only a page this worker controls can be sent elsewhere; otherwise open a new one.
        return win.navigate ? win.navigate(url).catch(() => self.clients.openWindow(url)) : self.clients.openWindow(url);
      }
      return self.clients.openWindow(url);
    }),
  );
});

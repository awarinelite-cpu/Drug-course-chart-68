// App-shell offline cache. This does NOT cache Firestore/Auth traffic — that's
// handled by Firestore's own IndexedDB persistence (see js/firebase.js), which
// queues writes made while offline and syncs them automatically on reconnect.
// This service worker's only job is making sure the pages/scripts themselves
// still load with no network at all (e.g. a ward with dead wifi).

const CACHE_NAME = 'narhy-app-shell-v1';

const PRECACHE_URLS = [
  './',
  './index.html',
  './login.html',
  './profile.html',
  './admin.html',
  './manifest.json',
  './js/auth-guard.js',
  './js/back-guard.js',
  './js/chart-common.js',
  './js/entry-chart.js',
  './js/export.js',
  './js/firebase.js',
  './js/nav.js',
  './js/styles.css',
  './charts/admission.html',
  './charts/blood-glucose.html',
  './charts/drug-course-chart.html',
  './charts/intake-output.html',
  './charts/overview.html',
  './charts/seizure.html',
  './charts/vitals.html'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {
      // Missing a file shouldn't block installation — the fetch handler still
      // caches things opportunistically as they're loaded.
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept writes

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let Firebase/Firestore/CDN traffic go straight to the network

  // Network-first, falling back to cache: while online this always serves the
  // latest version of the app and keeps the offline cache warm; while offline
  // it serves the last successfully loaded copy instead of failing outright.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});

// App-shell offline cache. This does NOT cache Firestore/Auth traffic — that's
// handled by Firestore's own IndexedDB persistence (see js/firebase.js), which
// queues writes made while offline and syncs them automatically on reconnect.
// This service worker's only job is making sure the pages/scripts themselves
// still load with no network at all (e.g. a ward with dead wifi).
//
// It also handles background FCM push messages (drug-due alerts, see
// js/push.js and functions/index.js) — that's the compat-SDK block below.
// Kept in this same file, rather than a separate firebase-messaging-sw.js,
// so there's only one service worker registered for the whole site.

// Self-hosted rather than pulled from gstatic.com: importScripts() runs at
// service worker evaluation time, so if that fetch fails (spotty ward wifi,
// a network that blocks Google CDN domains, an ad/content blocker) the whole
// worker fails to install with a bare "ServiceWorker script evaluation
// failed" and push/offline support silently breaks. Bundling these locally
// removes that external dependency entirely.
importScripts('./js/vendor/firebase/firebase-app-compat.js');
importScripts('./js/vendor/firebase/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBLEzC5MusezdNS8RnDQQA8xoI7XbXEqiM",
  authDomain: "gen-lang-client-0406053716.firebaseapp.com",
  projectId: "gen-lang-client-0406053716",
  storageBucket: "gen-lang-client-0406053716.firebasestorage.app",
  messagingSenderId: "922657172970",
  appId: "1:922657172970:web:f7a5c8f6ce8bb536d0d693"
});

// Written without optional chaining (?.) or other very-recent syntax on
// purpose: this whole file has to be parsed successfully before ANY of it
// runs, on ANY browser that loads it, or the entire service worker fails
// evaluation with an unhelpful generic error (this bit the app once already
// on an older Chrome/WebView build) -- an ordinary try/catch can't protect
// against that since it's a parse-time failure, not a runtime exception.
try {
  firebase.messaging().onBackgroundMessage((payload) => {
    const n = payload.notification || {};
    const d = payload.data || {};
    const title = n.title || 'Drug due';
    const body = n.body || '';
    const link = d.link || './index.html';
    self.registration.showNotification(title, {
      body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { link },
      tag: d.tag || undefined, // same tag replaces an older, now-stale alert instead of stacking
      // Browsers/OSes don't let a background service worker play a custom
      // sound — only the app's own foreground tab can (see js/push.js),
      // which covers the phone-in-hand case. For phone-locked/app-closed,
      // this is what's actually controllable: requireInteraction keeps the
      // notification pinned (Android won't auto-clear it after a few
      // seconds like a normal one), and vibrate gives a distinct, longer
      // buzz pattern than a default notification's single blip. Both are
      // still silenced entirely by phone-level silent/DND settings — no
      // web API can override that.
      requireInteraction: true,
      vibrate: [400, 200, 400, 200, 400, 200, 400]
    });
  });
} catch (e) {
  console.warn('Background push messaging unavailable on this device/browser:', e);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const link = data.link || './index.html';
  event.waitUntil(clients.openWindow(link));
});

const CACHE_NAME = 'narhy-app-shell-v3';

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

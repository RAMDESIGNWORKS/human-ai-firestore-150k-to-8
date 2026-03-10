// ============================================================
// SERVICE WORKER — Executive Assistant PWA
// Handles: app shell caching, push notifications,
//          notification click routing, offline fallback
// ============================================================

const CACHE_NAME = 'ea-shell-v1';
const OFFLINE_URL = '/offline.html';

// App shell — files that make the app work offline
const APP_SHELL = [
  '/',
  '/static/js/main.chunk.js',
  '/static/js/bundle.js',
  '/static/js/vendors~main.chunk.js',
  '/static/css/main.chunk.css',
  '/manifest.json',
  '/offline.html',
];

// ============================================================
// INSTALL — cache app shell
// ============================================================
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache what we can, ignore individual failures
      return Promise.allSettled(
        APP_SHELL.map(url =>
          cache.add(url).catch(() => {
            // Some files may not exist during dev — skip silently
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ============================================================
// ACTIVATE — clean up old caches
// ============================================================
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ============================================================
// FETCH — network-first for API, cache-first for assets
// ============================================================
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin (Firebase Functions, analytics, etc.)
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Navigation requests — network first, fallback to cached root
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/').then(cached => cached || caches.match(OFFLINE_URL))
      )
    );
    return;
  }

  // Static assets (JS, CSS, images) — cache first, network fallback
  if (
    url.pathname.startsWith('/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg')
  ) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }
});

// ============================================================
// PUSH — receive a push notification
// ============================================================
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'Executive Assistant', body: event.data.text() };
  }

  const title = data.title || 'EA Reminder';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: data.tag || 'ea-notification',
    renotify: data.renotify || false,
    requireInteraction: data.requireInteraction || false,
    silent: data.silent || false,
    data: {
      url: data.url || '/',
      sessionId: data.sessionId || null,
      type: data.type || 'general',
    },
    actions: data.actions || [
      { action: 'open', title: 'Open EA' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ============================================================
// NOTIFICATION CLICK — open app or specific session
// ============================================================
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const { action } = event;
  const { url, sessionId } = event.notification.data || {};

  if (action === 'dismiss') return;

  // Build the target URL
  const targetUrl = sessionId
    ? `${self.location.origin}/?session=${sessionId}`
    : (url || self.location.origin);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // If app is already open, focus it and navigate
      for (const client of windowClients) {
        if (client.url.startsWith(self.location.origin)) {
          client.focus();
          client.postMessage({ type: 'NOTIFICATION_CLICK', url: targetUrl, sessionId });
          return;
        }
      }
      // Otherwise open a new window
      return clients.openWindow(targetUrl);
    })
  );
});

// ============================================================
// NOTIFICATION CLOSE — analytics hook (optional)
// ============================================================
self.addEventListener('notificationclose', event => {
  // Can send analytics here — skipped for now
});

// ============================================================
// MESSAGE — handle commands from app
// ============================================================
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

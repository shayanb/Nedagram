// Service worker for offline support with proper update handling
// Version is injected at build time - see build script in package.json
const CACHE_VERSION = '__SW_VERSION__';
const CACHE_NAME = `nedagram-${CACHE_VERSION}`;

// Resources to precache on install (critical for offline)
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  console.log('[SW] Installing version:', CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    })
  );
  // Don't skipWaiting here - let the app control when to update
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating version:', CACHE_VERSION);
  event.waitUntil(
    // First, verify we have critical resources cached before deleting old caches
    caches.open(CACHE_NAME).then((cache) => {
      return cache.match('/index.html').then((response) => {
        if (!response) {
          // Critical resource not cached - try to fetch it now
          console.log('[SW] index.html not cached, fetching...');
          return cache.addAll(PRECACHE_URLS).catch(() => {
            console.warn('[SW] Failed to precache, keeping old caches');
          });
        }
        return Promise.resolve();
      });
    }).then(() => {
      // Now safe to delete old caches
      return caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name.startsWith('nedagram-') && name !== CACHE_NAME)
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      });
    })
  );
  // Take control of all clients
  self.clients.claim();
});

// Listen for skip waiting message from app
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] Skip waiting requested, activating new version');
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  const url = new URL(event.request.url);

  // For HTML (navigation requests): NETWORK-FIRST with cache fallback
  // Online: get fresh HTML, cache it
  // Offline: serve from cache
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Offline: serve cached HTML
          return caches.match(event.request).then((cached) => {
            return cached || caches.match('/index.html');
          });
        })
    );
    return;
  }

  // For JS/CSS assets: CACHE-FIRST with network fallback
  // These have hashes in filenames so they're immutable
  // Online first visit: fetch and cache
  // Subsequent visits (online or offline): serve from cache
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        // Not in cache - try network
        return fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse.ok) {
              const responseClone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, responseClone);
              });
            }
            return networkResponse;
          })
          .catch(() => {
            // Asset not cached and offline - this is a problem
            // Return a minimal error response instead of failing
            console.error('[SW] Asset not cached and offline:', event.request.url);
            return new Response('/* Offline - asset not cached */', {
              status: 503,
              statusText: 'Service Unavailable',
              headers: { 'Content-Type': 'text/plain' }
            });
          });
      })
    );
    return;
  }

  // For other resources: CACHE-FIRST with network fallback
  // This ensures offline works for all cached resources
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cache, but also update cache in background (stale-while-revalidate)
        fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse.ok) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, networkResponse);
              });
            }
          })
          .catch(() => {}); // Ignore network errors for background update
        return cachedResponse;
      }
      // Not cached - try network
      return fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Not cached and offline
          return new Response('Offline', { status: 503 });
        });
    })
  );
});

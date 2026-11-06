/* YourTurn PWA cache policy: static app shell only. Never cache APIs, auth, or Supabase data. */
const CACHE_NAME = 'yourturn-shell-v1';
const APP_SHELL = ['/', '/manifest.webmanifest', '/icons/icon.svg', '/icons/maskable.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys
      .filter((key) => key !== CACHE_NAME)
      .map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

function isCacheableStaticRequest(request, url) {
  if (request.method !== 'GET' || url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return false;
  return request.mode === 'navigate' || ['script', 'style', 'image', 'font', 'manifest'].includes(request.destination);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!isCacheableStaticRequest(event.request, url)) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => response)
        .catch(() => caches.match('/')),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok && response.type === 'basic') {
        const responseCopy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseCopy));
      }
      return response;
    })),
  );
});

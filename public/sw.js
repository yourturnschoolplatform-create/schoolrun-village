/* YourTurn PWA: static shell cache + Web Push for chat/match alerts.
   Never cache APIs, auth, or Supabase data. */
const CACHE_NAME = 'yourturn-shell-v2';
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

self.addEventListener('push', (event) => {
  let data = {
    title: 'SchoolRun Village',
    body: 'You have a new update.',
    url: '/messages',
    roomId: null,
  };
  try {
    if (event.data) {
      const parsed = event.data.json();
      data = {
        title: typeof parsed.title === 'string' ? parsed.title.slice(0, 80) : data.title,
        body: typeof parsed.body === 'string' ? parsed.body.slice(0, 160) : data.body,
        url: typeof parsed.url === 'string' ? parsed.url : data.url,
        roomId: typeof parsed.roomId === 'string' ? parsed.roomId : null,
      };
    }
  } catch {
    try {
      const text = event.data?.text();
      if (text) data.body = text.slice(0, 160);
    } catch {
      /* keep defaults */
    }
  }

  // SPA has no /messages router — map to ?view=messages / ?openChat=<roomId>.
  const targetUrl = data.roomId
    ? `/messages?openChat=${encodeURIComponent(data.roomId)}`
    : (data.url && data.url !== '/messages' ? data.url : '/messages');

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      data: { url: targetUrl, roomId: data.roomId },
      tag: data.roomId ? `chat-${data.roomId}` : `notify-${Date.now()}`,
      renotify: true,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url)
    || '/messages';

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) {
          try {
            await client.navigate(target);
            return;
          } catch {
            /* fall through */
          }
        }
        client.postMessage({ type: 'open-chat', url: target });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

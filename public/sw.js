/* YourTurn PWA: static shell cache + Web Push for chat/match alerts.
   Never cache APIs, auth, or Supabase data. */
const CACHE_NAME = 'yourturn-shell-v5';
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

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Build SPA deep-link into a specific 1:1 room. */
function chatDeepLink(roomId, kind) {
  if (isUuid(roomId)) {
    const params = new URLSearchParams({
      view: 'messages',
      openChat: roomId,
      room: roomId,
    });
    if (kind === 'match' || kind === 'marketplace' || kind === 'instant_pickup') {
      params.set('chatKind', kind);
    }
    return `/?${params.toString()}`;
  }
  return '/?view=messages';
}

function parsePushPayload(event) {
  const fallback = {
    title: 'SchoolRun Village',
    body: 'You have a new message.',
    roomId: null,
    listingId: null,
    matchId: null,
    kind: 'chat',
    context: null,
    url: '/?view=messages',
  };
  if (!event.data) return fallback;
  try {
    const parsed = event.data.json();
    const roomId = isUuid(parsed.roomId) ? parsed.roomId
      : (isUuid(parsed.room) ? parsed.room : null);
    const listingId = isUuid(parsed.listingId) ? parsed.listingId : null;
    const matchId = isUuid(parsed.matchId) ? parsed.matchId
      : (isUuid(parsed.requestId) ? parsed.requestId : null);
    const kind = typeof parsed.kind === 'string' ? parsed.kind : 'chat';
    const context = typeof parsed.context === 'string' ? parsed.context.slice(0, 80) : null;
    const title = typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim().slice(0, 80)
      : (kind === 'match' ? 'Pickup match' : 'New message');
    let body = typeof parsed.body === 'string' ? parsed.body.trim().slice(0, 160) : fallback.body;
    if (context && body && !body.includes(context)) {
      body = `${context} · ${body}`.slice(0, 160);
    }
    const url = typeof parsed.url === 'string' && parsed.url.trim()
      ? parsed.url.trim()
      : chatDeepLink(roomId, kind);
    return { title, body, roomId, listingId, matchId, kind, context, url };
  } catch {
    try {
      const text = event.data?.text();
      if (text) return { ...fallback, body: text.slice(0, 160) };
    } catch {
      /* keep defaults */
    }
    return fallback;
  }
}

self.addEventListener('push', (event) => {
  const data = parsePushPayload(event);
  const targetUrl = data.roomId ? chatDeepLink(data.roomId, data.kind) : data.url;

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      tag: data.roomId ? `chat-${data.roomId}` : 'chat-msg',
      renotify: true,
      silent: false,
      vibrate: [200, 100, 200],
      requireInteraction: false,
      data: {
        url: targetUrl,
        roomId: data.roomId,
        listingId: data.listingId,
        matchId: data.matchId,
        kind: data.kind,
        context: data.context,
        openChat: data.roomId,
      },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const payload = event.notification.data || {};
  const roomId = isUuid(payload.roomId) ? payload.roomId
    : (isUuid(payload.openChat) ? payload.openChat : null);
  const kind = typeof payload.kind === 'string' ? payload.kind : 'chat';
  const listingId = isUuid(payload.listingId) ? payload.listingId : null;
  const matchId = isUuid(payload.matchId) ? payload.matchId : null;
  const target = roomId
    ? chatDeepLink(roomId, kind)
    : (typeof payload.url === 'string' && payload.url.trim() ? payload.url.trim() : '/?view=messages');

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if (!('focus' in client)) continue;
      await client.focus();
      // Prefer postMessage so the SPA opens the exact room without a full reload.
      client.postMessage({
        type: 'open-chat',
        url: target,
        roomId,
        listingId,
        matchId,
        kind,
        openChat: roomId,
      });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

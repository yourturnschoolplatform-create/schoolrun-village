import type { SupabaseClient } from '@supabase/supabase-js';

export type PushPermissionState = 'unsupported' | 'denied' | 'default' | 'granted' | 'subscribed';

function urlBase64ToUint8Array(base64String: string): BufferSource {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
}

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua);
  const chrome = /CriOS|Chrome|EdgiOS|FxiOS/.test(ua);
  return iOS && webkit && !chrome;
}

export function pushPlatformNote(): string | null {
  if (typeof window === 'undefined') return null;
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    return isIosSafari()
      ? 'On iPhone, tap Share → Add to Home Screen, then open SchoolRun Village from your Home Screen to enable alerts.'
      : 'This browser does not support Web Push notifications.';
  }
  if (isIosSafari() && !window.matchMedia('(display-mode: standalone)').matches) {
    return 'On iPhone, add SchoolRun Village to your Home Screen (Share → Add to Home Screen), then turn on alerts from the app icon.';
  }
  return null;
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window;
}

/** Prefer Vite public VAPID key; fall back to /api/push/vapid-public-key. */
export function readViteVapidPublicKey(): string | null {
  try {
    const env = (import.meta as ImportMeta & { env?: { VITE_VAPID_PUBLIC_KEY?: string } }).env;
    const key = env?.VITE_VAPID_PUBLIC_KEY?.trim() ?? '';
    return key || null;
  } catch {
    return null;
  }
}

export async function resolveVapidPublicKey(explicit?: string | null): Promise<string | null> {
  const fromProp = explicit?.trim() || null;
  if (fromProp) return fromProp;
  const fromVite = readViteVapidPublicKey();
  if (fromVite) return fromVite;
  try {
    const response = await fetch('/api/push/vapid-public-key', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body = await response.json() as { publicKey?: string | null };
    return typeof body.publicKey === 'string' && body.publicKey.trim()
      ? body.publicKey.trim()
      : null;
  } catch {
    return null;
  }
}

async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

export const pushApi = {
  platformNote: pushPlatformNote,
  supported: pushSupported,

  permissionState: async (): Promise<PushPermissionState> => {
    if (!pushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    if (Notification.permission === 'default') return 'default';
    const registration = await activeRegistration();
    const existing = await registration?.pushManager.getSubscription();
    return existing ? 'subscribed' : 'granted';
  },

  /**
   * Ask for permission, subscribe with VAPID (`VITE_VAPID_PUBLIC_KEY` or arg),
   * and upsert into push_subscriptions via RPC.
   */
  enable: async (client: SupabaseClient, vapidPublicKey?: string | null): Promise<boolean> => {
    if (!pushSupported()) return false;
    const key = (await resolveVapidPublicKey(vapidPublicKey))?.trim() ?? '';
    if (!key) {
      console.error('push enable: VAPID public key missing');
      return false;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;

    return pushApi.persistBrowserSubscription(client, key);
  },

  disable: async (client: SupabaseClient): Promise<void> => {
    const registration = await activeRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    const endpoint = subscription?.endpoint;
    if (subscription) {
      try {
        await subscription.unsubscribe();
      } catch {
        /* ignore */
      }
    }
    if (endpoint) {
      try {
        await client.rpc('delete_push_subscription', { p_endpoint: endpoint });
      } catch {
        /* ignore */
      }
    }
  },

  /**
   * After Notification.permission === 'granted', create/reuse pushManager.subscribe
   * and upsert into push_subscriptions. Shared by enable() + syncSubscription().
   */
  persistBrowserSubscription: async (
    client: SupabaseClient,
    vapidPublicKey: string,
  ): Promise<boolean> => {
    try {
      const registration = await activeRegistration();
      if (!registration) {
        console.error('push subscribe: service worker registration unavailable');
        return false;
      }

      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        });
      }

      const json = subscription.toJSON();
      const endpoint = json.endpoint?.trim() ?? '';
      const p256dh = json.keys?.p256dh?.trim() ?? '';
      const auth = json.keys?.auth?.trim() ?? '';
      if (!endpoint || !p256dh || !auth) {
        console.error('push subscribe: incomplete PushSubscription keys');
        return false;
      }

      const { error } = await client.rpc('upsert_push_subscription', {
        p_endpoint: endpoint,
        p_p256dh: p256dh,
        p_auth: auth,
        p_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 512) : null,
      });
      if (error) {
        console.error('upsert_push_subscription', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        return false;
      }
      return true;
    } catch (error) {
      console.error(
        'push subscribe failed',
        error instanceof Error ? error.message : 'unknown',
      );
      return false;
    }
  },

  /**
   * When permission is already granted, ensure the browser subscription exists
   * and is upserted into push_subscriptions (login / chat entry sync).
   * Does not call Notification.requestPermission (no gesture required).
   */
  syncSubscription: async (
    client: SupabaseClient,
    vapidPublicKey?: string | null,
  ): Promise<boolean> => {
    if (!pushSupported()) return false;
    if (Notification.permission !== 'granted') return false;
    const key = (await resolveVapidPublicKey(vapidPublicKey))?.trim() ?? '';
    if (!key) {
      console.error('push sync: VAPID public key missing');
      return false;
    }
    return pushApi.persistBrowserSubscription(client, key);
  },

  /**
   * POST /functions/v1/send-chat-push
   * Body: { kind: "chat", roomId, preview, title?, context?, listingId? }
   * Fire-and-forget — never throws into chat UX.
   */
  notifyChatPeer: async (
    accessToken: string,
    roomId: string,
    preview: string,
    options?: {
      title?: string | null;
      context?: string | null;
      listingId?: string | null;
    },
  ): Promise<void> => {
    const body = {
      kind: 'chat' as const,
      roomId,
      preview: sanitizeChatPreview(preview),
      title: options?.title?.trim()?.slice(0, 80) || undefined,
      context: options?.context?.trim()?.slice(0, 80) || undefined,
      listingId: options?.listingId || undefined,
    };
    const ok = await postSendChatPush(accessToken, body);
    if (ok) return;
    await postExpressFallback('/api/push/notify-chat', accessToken, {
      roomId,
      preview: body.preview,
      title: body.title,
      context: body.context,
      listingId: body.listingId,
    });
  },

  /**
   * POST /functions/v1/send-chat-push
   * Body: { kind: "match", requestId, roomId?, matchId? }
   */
  notifyMatchPeer: async (
    accessToken: string,
    requestId: string,
    roomId: string | null,
  ): Promise<void> => {
    const body = {
      kind: 'match' as const,
      requestId,
      roomId,
      matchId: requestId,
      context: 'Instant Pickup',
    };
    const ok = await postSendChatPush(accessToken, body);
    if (ok) return;
    await postExpressFallback('/api/push/notify-match', accessToken, {
      requestId,
      roomId,
      matchId: requestId,
      context: 'Instant Pickup',
    });
  },

  /** Resolve session from Supabase client, then notify chat peer (best-effort). */
  notifyChatPeerFromClient: async (
    client: SupabaseClient,
    roomId: string,
    preview: string,
    options?: {
      title?: string | null;
      context?: string | null;
      listingId?: string | null;
    },
  ): Promise<void> => {
    const token = await readAccessToken(client);
    if (!token) return;
    await pushApi.notifyChatPeer(token, roomId, preview, options);
  },

  /** Resolve session from Supabase client, then notify match peer (best-effort). */
  notifyMatchPeerFromClient: async (
    client: SupabaseClient,
    requestId: string,
    roomId: string | null,
  ): Promise<void> => {
    const token = await readAccessToken(client);
    if (!token) return;
    await pushApi.notifyMatchPeer(token, requestId, roomId);
  },
};

function sanitizeChatPreview(raw: string): string {
  const text = (raw ?? '').trim();
  if (!text) return 'New message';
  // Never push the raw one-time household confirmation code payload.
  if (/^HOUSEHOLD_CONFIRM_CODE::/i.test(text)) {
    return 'Household confirmation code';
  }
  return text.slice(0, 120).replace(/\+?\d[\d\s()-]{7,}\d/g, '•••');
}

async function readAccessToken(client: SupabaseClient): Promise<string | null> {
  try {
    const { data } = await client.auth.getSession();
    return data.session?.access_token?.trim() || null;
  } catch {
    return null;
  }
}

type MetaEnv = {
  VITE_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  YOURTURN_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
  YOURTURN_SUPABASE_ANON_KEY?: string;
};

function readMetaEnv(): MetaEnv {
  try {
    return ((import.meta as ImportMeta & { env?: MetaEnv }).env) ?? {};
  } catch {
    return {};
  }
}

function readSupabaseFunctionsConfig(): { base: string; anonKey: string } | null {
  const env = readMetaEnv();
  const url = (
    env.YOURTURN_SUPABASE_URL
    || env.VITE_SUPABASE_URL
    || env.NEXT_PUBLIC_SUPABASE_URL
    || ''
  ).trim().replace(/\/+$/, '');
  const anonKey = (
    env.YOURTURN_SUPABASE_ANON_KEY
    || env.VITE_SUPABASE_ANON_KEY
    || env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    || ''
  ).replace(/\s/g, '');
  if (!url) return null;
  return { base: `${url}/functions/v1`, anonKey };
}

async function postSendChatPush(
  accessToken: string,
  body: { kind: 'chat' | 'match' } & Record<string, unknown>,
): Promise<boolean> {
  const config = readSupabaseFunctionsConfig();
  if (!config) return false;
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    };
    // Supabase gateway expects apikey alongside the user JWT.
    if (config.anonKey) headers.apikey = config.anonKey;

    const response = await fetch(`${config.base}/send-chat-push`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error('send-chat-push', { status: response.status, kind: body.kind });
    }
    return response.ok;
  } catch (error) {
    console.error('send-chat-push', error instanceof Error ? error.message : 'network');
    return false;
  }
}

async function postExpressFallback(
  path: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    /* best-effort */
  }
}

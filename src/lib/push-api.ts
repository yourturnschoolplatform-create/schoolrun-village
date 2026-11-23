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
    if (!key) return false;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;

    const registration = await activeRegistration();
    if (!registration) return false;

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }

    const json = subscription.toJSON();
    const endpoint = json.endpoint?.trim() ?? '';
    const p256dh = json.keys?.p256dh?.trim() ?? '';
    const auth = json.keys?.auth?.trim() ?? '';
    if (!endpoint || !p256dh || !auth) return false;

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
   * Prefer Supabase Edge Function `send-chat-push`; fall back to Express `/api/push/*`.
   */
  notifyChatPeer: async (accessToken: string, roomId: string, preview: string): Promise<void> => {
    const body = {
      kind: 'chat' as const,
      roomId,
      preview: preview.slice(0, 120),
    };
    const ok = await postSendChatPush(accessToken, body);
    if (ok) return;
    try {
      await fetch('/api/push/notify-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ roomId, preview: body.preview }),
      });
    } catch {
      /* best-effort */
    }
  },

  notifyMatchPeer: async (accessToken: string, requestId: string, roomId: string | null): Promise<void> => {
    const body = {
      kind: 'match' as const,
      requestId,
      roomId,
    };
    const ok = await postSendChatPush(accessToken, body);
    if (ok) return;
    try {
      await fetch('/api/push/notify-match', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ requestId, roomId }),
      });
    } catch {
      /* best-effort */
    }
  },
};

function readSupabaseFunctionsBase(): string | null {
  try {
    const env = (import.meta as ImportMeta & {
      env?: { VITE_SUPABASE_URL?: string; NEXT_PUBLIC_SUPABASE_URL?: string };
    }).env;
    const url = (env?.VITE_SUPABASE_URL || env?.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
    return url ? `${url}/functions/v1` : null;
  } catch {
    return null;
  }
}

async function postSendChatPush(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const base = readSupabaseFunctionsBase();
  if (!base) return false;
  try {
    const response = await fetch(`${base}/send-chat-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch {
    return false;
  }
}

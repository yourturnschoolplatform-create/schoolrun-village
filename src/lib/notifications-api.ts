import type { SupabaseClient } from '@supabase/supabase-js';

export type InboxNotification = {
  id: string;
  title: string;
  body: string;
  kind: string;
  is_read: boolean;
  created_at: string;
};

/** Soft ceiling so inbox list never hangs the Matches UI. */
export const NOTIFICATION_LIST_TIMEOUT_MS = 5_000;

async function request<T>(client: SupabaseClient, path: string, init: RequestInit = {}): Promise<T> {
  try {
    const { data, error } = await client.auth.getSession();
    if (error || !data.session?.access_token) throw new Error('Unauthenticated');
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${data.session.access_token}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(`/api/notifications${path}`, { ...init, cache: 'no-store', headers });
    if (!response.ok) throw new Error('Notification request failed');
    return await response.json() as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new Error('That notification action could not be completed. Please try again.');
  }
}

export const notificationsApi = {
  list: async (
    client: SupabaseClient,
    options?: { unreadOnly?: boolean; signal?: AbortSignal },
  ) => {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    options?.signal?.addEventListener('abort', onExternalAbort);

    const timeoutId = setTimeout(() => {
      controller.abort();
    }, NOTIFICATION_LIST_TIMEOUT_MS);

    try {
      return await request<{ notifications: InboxNotification[] }>(
        client,
        options?.unreadOnly ? '?unreadOnly=true' : '',
        { signal: controller.signal },
      );
    } catch (err) {
      if (controller.signal.aborted && options?.signal?.aborted !== true) {
        throw new Error('Notification fetch timeout');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      options?.signal?.removeEventListener('abort', onExternalAbort);
    }
  },
  markRead: (client: SupabaseClient, notificationId: string) =>
    request<{ notification: InboxNotification }>(
      client,
      `/${encodeURIComponent(notificationId)}/read`,
      { method: 'POST', body: '{}' },
    ),
  markAllRead: (client: SupabaseClient) =>
    request<{ outcome: string; markedCount: number }>(client, '/read-all', {
      method: 'POST',
      body: '{}',
    }),
};

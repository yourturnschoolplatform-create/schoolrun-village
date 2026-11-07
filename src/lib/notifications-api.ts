import type { SupabaseClient } from '@supabase/supabase-js';

export type InboxNotification = {
  id: string;
  title: string;
  body: string;
  kind: string;
  is_read: boolean;
  created_at: string;
};

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
  } catch {
    throw new Error('That notification action could not be completed. Please try again.');
  }
}

export const notificationsApi = {
  list: (client: SupabaseClient, options?: { unreadOnly?: boolean; signal?: AbortSignal }) =>
    request<{ notifications: InboxNotification[] }>(
      client,
      options?.unreadOnly ? '?unreadOnly=true' : '',
      { signal: options?.signal },
    ),
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

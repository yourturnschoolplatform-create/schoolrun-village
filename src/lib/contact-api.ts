import type { SupabaseClient } from '@supabase/supabase-js';

export type ContactConsent = {
  id: string;
  consentVersion: number;
  policyVersion: number;
  scope: string;
  grantedAt: string;
  defaultContactMethod: 'email_relay';
};

export type ContactNotification = {
  id: string;
  swap_id: string;
  kind: string;
  message: string;
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
    const response = await fetch(`/api/contacts${path}`, { ...init, cache: 'no-store', headers });
    if (!response.ok) throw new Error('Contact request failed');
    return await response.json() as T;
  } catch {
    // Never surface a response body or underlying error that could contain a mobile number.
    throw new Error('That contact action could not be completed. Please try again.');
  }
}

export const contactApi = {
  grant: (client: SupabaseClient, swapId: string, input: { mobileNumber: string; chosenBackups: string[] }) =>
    request<{ consent: ContactConsent }>(client, `/swaps/${encodeURIComponent(swapId)}/grant`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  revoke: (client: SupabaseClient, swapId: string) =>
    request<{ status: 'cancelled_consent_revoked' }>(client, `/swaps/${encodeURIComponent(swapId)}/revoke`, { method: 'POST' }),
  shared: (client: SupabaseClient, swapId: string, memberId: string) =>
    request<{ mobileNumber: string | null }>(client, `/swaps/${encodeURIComponent(swapId)}/shared/${encodeURIComponent(memberId)}`),
  notifications: (client: SupabaseClient, signal?: AbortSignal) =>
    request<{ notifications: ContactNotification[] }>(client, '/notifications', { signal }),
};

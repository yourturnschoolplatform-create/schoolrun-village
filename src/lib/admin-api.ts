import type { SupabaseClient } from '@supabase/supabase-js';

/** Matches list_admin_audit_actions projection (no admin_email). */
export type AdminAuditAction = {
  id: string;
  actor_id: string | null;
  school_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  occurred_at: string;
  payload: Record<string, string>;
};

/** Matches list_admin_safety_holds projection. */
export type AdminSafetyHold = {
  id: string;
  school_id: string;
  subject_user_id: string;
  status: string;
  reason_code: string;
  placed_at: string;
  review_due_at: string | null;
  resolved_at: string | null;
};

/** Matches list_admin_suspended_users projection (no free-text reason). */
export type AdminSuspendedUser = {
  user_id: string;
  admin_suspended: boolean;
  updated_at: string;
};

async function request<T>(client: SupabaseClient, path: string, init: RequestInit = {}): Promise<T> {
  try {
    const { data, error } = await client.auth.getSession();
    if (error || !data.session?.access_token) throw new Error('Unauthenticated');
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${data.session.access_token}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(`/api/admin${path}`, { ...init, cache: 'no-store', headers });
    if (!response.ok) throw new Error('Admin request failed');
    return await response.json() as T;
  } catch {
    throw new Error('That admin action could not be completed. Please try again.');
  }
}

export const adminApi = {
  listAuditActions: (client: SupabaseClient, limit = 50, signal?: AbortSignal) =>
    request<{ actions: AdminAuditAction[] }>(client, `/audit-actions?limit=${limit}`, { signal }),

  listSafetyHolds: (client: SupabaseClient, signal?: AbortSignal) =>
    request<{ holds: AdminSafetyHold[] }>(client, '/safety-holds', { signal }),

  listSuspendedUsers: (client: SupabaseClient, signal?: AbortSignal) =>
    request<{ users: AdminSuspendedUser[] }>(client, '/suspended-users', { signal }),

  suspendUser: (client: SupabaseClient, userId: string, reasonCode: string) =>
    request<{ result: { user_id: string; admin_suspended: boolean; outcome: string } }>(
      client,
      `/users/${encodeURIComponent(userId)}/suspend`,
      { method: 'POST', body: JSON.stringify({ reasonCode }) },
    ),

  unsuspendUser: (client: SupabaseClient, userId: string, reasonCode: string) =>
    request<{ result: { user_id: string; admin_suspended: boolean; outcome: string } }>(
      client,
      `/users/${encodeURIComponent(userId)}/unsuspend`,
      { method: 'POST', body: JSON.stringify({ reasonCode }) },
    ),

  resolveSafetyHold: (
    client: SupabaseClient,
    subjectUserId: string,
    outcome: 'lift' | 'uphold',
    reasonCode = 'admin_review',
  ) =>
    request<{ result: {
      hold_id: string;
      subject_user_id: string;
      school_id: string;
      outcome: string;
    } }>(
      client,
      `/users/${encodeURIComponent(subjectUserId)}/safety-holds/resolve`,
      { method: 'POST', body: JSON.stringify({ outcome, reasonCode }) },
    ),
};

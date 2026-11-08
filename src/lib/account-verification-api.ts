import type { SupabaseClient } from '@supabase/supabase-js';
import {
  normalizeAccountRole,
  normalizeAccountStatus,
  type AccountVerificationSnapshot,
  type PendingAccountVerification,
} from '../../shared/account-verification';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mapSnapshot(raw: unknown): AccountVerificationSnapshot {
  const row = asRecord(raw);
  return {
    accountStatus: normalizeAccountStatus(row.accountStatus ?? row.account_status),
    accountRole: normalizeAccountRole(row.accountRole ?? row.account_role),
    schoolId: typeof row.schoolId === 'string' ? row.schoolId : typeof row.school_id === 'string' ? row.school_id : null,
    invitationCodePresent: row.invitationCodePresent === true || row.invitation_code_present === true,
    verifiedAt: typeof row.verifiedAt === 'string' ? row.verifiedAt : typeof row.verified_at === 'string' ? row.verified_at : null,
    suburb: typeof row.suburb === 'string' ? row.suburb : null,
    schoolLabel: typeof row.schoolLabel === 'string' ? row.schoolLabel : typeof row.school_label === 'string' ? row.school_label : null,
    displayName: typeof row.displayName === 'string' ? row.displayName : typeof row.display_name === 'string' ? row.display_name : 'Parent',
  };
}

function mapPending(raw: unknown): PendingAccountVerification {
  const row = asRecord(raw);
  return {
    userId: String(row.userId ?? row.user_id ?? ''),
    displayName: String(row.displayName ?? row.display_name ?? 'Parent'),
    accountStatus: normalizeAccountStatus(row.accountStatus ?? row.account_status),
    accountRole: normalizeAccountRole(row.accountRole ?? row.account_role),
    schoolId: typeof row.schoolId === 'string' ? row.schoolId : typeof row.school_id === 'string' ? row.school_id : null,
    suburb: typeof row.suburb === 'string' ? row.suburb : null,
    schoolLabel: typeof row.schoolLabel === 'string' ? row.schoolLabel : typeof row.school_label === 'string' ? row.school_label : null,
    invitationCodePresent: row.invitationCodePresent === true || row.invitation_code_present === true,
    createdAt: String(row.createdAt ?? row.created_at ?? ''),
  };
}

async function adminRequest<T>(client: SupabaseClient, path: string, init: RequestInit = {}): Promise<T> {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session?.access_token) throw new Error('Unauthenticated');
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  headers.set('Authorization', `Bearer ${data.session.access_token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/admin${path}`, { ...init, cache: 'no-store', headers });
  if (!response.ok) throw new Error('Admin verification request failed');
  return await response.json() as T;
}

export const accountVerificationApi = {
  getMine: async (client: SupabaseClient): Promise<AccountVerificationSnapshot> => {
    const { data, error } = await client.rpc('get_my_account_verification');
    if (error) throw new Error(error.message);
    return mapSnapshot(data);
  },

  completeParentSignup: async (
    client: SupabaseClient,
    input: {
      displayName: string;
      suburb: string;
      schoolLabel: string;
      schoolId?: string | null;
      invitationCode?: string | null;
    },
  ): Promise<AccountVerificationSnapshot> => {
    const { data, error } = await client.rpc('complete_parent_signup', {
      p_display_name: input.displayName.trim(),
      p_suburb: input.suburb.trim(),
      p_school_label: input.schoolLabel.trim(),
      p_school_id: input.schoolId || null,
      p_invitation_code: input.invitationCode?.trim() || null,
    });
    if (error) throw new Error(error.message);
    const row = asRecord(data);
    return {
      accountStatus: normalizeAccountStatus(row.accountStatus),
      accountRole: normalizeAccountRole(row.accountRole),
      schoolId: typeof row.schoolId === 'string' ? row.schoolId : null,
      invitationCodePresent: Boolean(input.invitationCode?.trim()),
      verifiedAt: typeof row.verifiedAt === 'string' ? row.verifiedAt : null,
      suburb: input.suburb.trim(),
      schoolLabel: input.schoolLabel.trim(),
      displayName: input.displayName.trim(),
    };
  },

  listPending: (client: SupabaseClient, schoolId?: string | null) =>
    adminRequest<{ users: PendingAccountVerification[] }>(
      client,
      `/users/pending-verifications${schoolId ? `?schoolId=${encodeURIComponent(schoolId)}` : ''}`,
    ).then((result) => ({
      users: (result.users ?? []).map(mapPending),
    })),

  verifyUser: (client: SupabaseClient, userId: string, decision: 'approve' | 'reject') =>
    adminRequest<{ result: { ok: boolean; userId: string; accountStatus: string; verifiedAt: string | null } }>(
      client,
      `/users/${encodeURIComponent(userId)}/verify`,
      { method: 'POST', body: JSON.stringify({ decision }) },
    ),
};

export async function registerAdminAccount(input: {
  email: string;
  password: string;
  displayName: string;
  adminSecret: string;
}): Promise<{ ok: true; message: string }> {
  const response = await fetch('/api/admin/signup', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : 'Admin signup failed');
  }
  return { ok: true, message: typeof payload.message === 'string' ? payload.message : 'Admin account created.' };
}

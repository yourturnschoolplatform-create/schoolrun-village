import type { SupabaseClient } from '@supabase/supabase-js';
import type { MembershipStatus } from '../../shared/onboarding';

export type ConsentDocument = {
  id: string;
  document_type: 'terms' | 'privacy' | 'community_safety';
  version: number;
  title: string;
  summary: string;
};

export type OnboardingStatus = {
  emailVerified: boolean;
  profile: {
    displayName: string;
    accountStatus?: string | null;
    accountRole?: string | null;
    schoolId?: string | null;
    verifiedAt?: string | null;
    suburb?: string | null;
    schoolLabel?: string | null;
  } | null;
  membership: { id: string; status: MembershipStatus; approved_at: string | null } | null;
  consentDocuments: ConsentDocument[];
  acceptedConsentDocumentIds: string[];
  childCount: number;
  safetyDeclarationIds: string[];
  currentSafetyDeclaration: { id: string; title: string; summary: string } | null;
  roles: Array<{ role: 'parent' | 'moderator' | 'admin'; school_id: string | null }>;
};

export type SchoolOption = { id: string; display_name: string };
export type PendingMembership = { membership_id: string; display_name: string };

async function request<T>(client: SupabaseClient, path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await client.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error('Please sign in again to continue.');

  const response = await fetch(`/api/onboarding${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error('Please verify your email and sign in again to continue.');
    if (response.status === 429) throw new Error('Too many attempts. Please wait before trying another code.');
    // Generic failures never use invitation-link copy. Invite-specific wording is
    // reserved for claimInvitation (only called when ?invite= is present).
    throw new Error('Something went wrong. Please try again.');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const onboardingApi = {
  status: (client: SupabaseClient) => request<OnboardingStatus>(client, '/status'),
  acceptConsent: (client: SupabaseClient, documentType: ConsentDocument['document_type'], version: number) =>
    request<void>(client, '/consents', { method: 'POST', body: JSON.stringify({ documentType, version }) }),
  schoolOptions: async (client: SupabaseClient) => {
    const data = await request<{ schools: SchoolOption[] }>(client, '/school-options');
    return data.schools;
  },
  joinSchool: (client: SupabaseClient, schoolId: string, inviteCode: string) =>
    request<{ status: string }>(client, '/school-membership', { method: 'POST', body: JSON.stringify({ schoolId, inviteCode }) }),
  saveProfile: (client: SupabaseClient, displayName: string) =>
    request<void>(client, '/profile', { method: 'POST', body: JSON.stringify({ displayName }) }),
  addChild: (client: SupabaseClient, membershipId: string, nickname: string, yearLevel: number) =>
    request<{ childId: string }>(client, '/children', { method: 'POST', body: JSON.stringify({ membershipId, nickname, yearLevel }) }),
  signSafetyDeclaration: (client: SupabaseClient, membershipId: string, declarationVersionId: string) =>
    request<{ status: string }>(client, '/safety-declaration', { method: 'POST', body: JSON.stringify({ membershipId, declarationVersionId }) }),
  claimInvitation: async (client: SupabaseClient, token: string) => {
    const trimmed = token.trim();
    if (!trimmed) throw new Error('Something went wrong. Please try again.');

    const { data } = await client.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) throw new Error('Please sign in again to continue.');

    const response = await fetch('/api/onboarding/invitations/claim', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: trimmed }),
    });

    if (response.status === 401) throw new Error('Please verify your email and sign in again to continue.');
    if (response.status === 404) throw new Error('That invitation link is unavailable or already used.');
    if (!response.ok) throw new Error('Something went wrong. Please try again.');
    return response.json() as Promise<{ status: string }>;
  },
  pendingMemberships: async (client: SupabaseClient) => {
    const data = await request<{ memberships: PendingMembership[] }>(client, '/moderation/pending-memberships');
    return data.memberships;
  },
  createInvitation: (client: SupabaseClient, schoolId: string) =>
    request<{ token: string }>(client, '/moderation/invitations', { method: 'POST', body: JSON.stringify({ schoolId }) }),
  approveMembership: (client: SupabaseClient, membershipId: string) =>
    request<{ status: string }>(client, `/moderation/memberships/${membershipId}/approve`, { method: 'POST' }),
  reviewMembership: (client: SupabaseClient, membershipId: string, state: 'rejected' | 'suspended') =>
    request<{ status: string }>(client, `/moderation/memberships/${membershipId}/review`, { method: 'POST', body: JSON.stringify({ state }) }),
};

/** Invitation-link opening returns only generic state, never a school identity. */
export async function openInvitationLink(
  token: string,
  accessToken?: string | null,
): Promise<'opened' | 'unavailable'> {
  const response = await fetch('/api/onboarding/invitations/open', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) return 'unavailable';
  const result = (await response.json()) as { status: 'opened' | 'unavailable' };
  return result.status;
}

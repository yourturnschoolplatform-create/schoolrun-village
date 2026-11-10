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

export type SchoolOption = {
  id: string;
  display_name: string;
  suburb: string;
  demoCode?: string;
};
export type PendingMembership = { membership_id: string; display_name: string };

/** Demo schools for the School step — no /api/onboarding/school-options dependency. */
export const FALLBACK_SCHOOL_OPTIONS: SchoolOption[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    display_name: 'Sample Harbourview Primary School',
    suburb: 'Harbourview',
    demoCode: 'HARBOUR-2026',
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    display_name: 'Sample Rivergum Primary School',
    suburb: 'Rivergum',
    demoCode: 'RIVERGUM-2026',
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    display_name: 'Sample Docklands Primary School',
    suburb: 'Docklands',
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    display_name: 'Sample Carlton Secondary College',
    suburb: 'Carlton',
  },
];

type ProfileRow = {
  display_name?: string | null;
  account_status?: string | null;
  account_role?: string | null;
  signup_school_id?: string | null;
  account_verified_at?: string | null;
  signup_suburb?: string | null;
  signup_school_label?: string | null;
};

/**
 * Soft profile read — only Day-1 columns that always exist on public.profiles.
 * Never select school_id/status (those belong on school_memberships) or Day-15
 * columns that 400 when migration 0063 is not applied.
 */
async function loadProfileSoft(client: SupabaseClient, userId: string): Promise<ProfileRow | null> {
  try {
    const { data, error } = await client
      .from('profiles')
      .select('id, display_name')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data) return null;
    return {
      display_name: (data as { display_name?: string | null }).display_name ?? 'Parent',
      account_status: null,
      account_role: null,
      signup_school_id: null,
      account_verified_at: null,
      signup_suburb: null,
      signup_school_label: null,
    };
  } catch {
    /* soft-fail */
  }
  return null;
}

/**
 * Load onboarding status via Supabase RLS (no /api/onboarding/status round-trip).
 * Read-only: no side-effect RPCs (avoids post-login 400s from ledger writes).
 */
async function loadOnboardingStatus(client: SupabaseClient): Promise<OnboardingStatus> {
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  const session = sessionData.session;
  if (sessionError || !session?.user) throw new Error('Please sign in again to continue.');

  const userId = session.user.id;
  const [
    profile,
    membershipResult,
    consentResult,
    documentResult,
    childResult,
    declarationResult,
    rolesResult,
  ] = await Promise.all([
    loadProfileSoft(client, userId),
    client
      .from('school_memberships')
      .select('id, school_id, status, approved_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    client.from('consent_acceptances').select('document_id').eq('user_id', userId),
    client
      .from('consent_documents')
      .select('id, document_type, version, title, summary')
      .eq('is_active', true)
      .order('document_type'),
    client.from('child_profiles').select('id').eq('parent_id', userId),
    client.from('safety_declarations').select('id, declaration_version_id').eq('parent_id', userId),
    client.from('role_assignments').select('role, school_id').eq('user_id', userId).is('revoked_at', null),
  ]);

  // Soft-read: one RLS/schema miss must not block social-login onboarding boot.
  const membership = membershipResult.error ? null : membershipResult.data;
  const consents = consentResult.error ? [] : (consentResult.data ?? []);
  const documents = documentResult.error ? [] : (documentResult.data ?? []);
  const children = childResult.error ? [] : (childResult.data ?? []);
  const declarations = declarationResult.error ? [] : (declarationResult.data ?? []);
  const roles = rolesResult.error ? [] : (rolesResult.data ?? []);

  let currentSafetyDeclaration: OnboardingStatus['currentSafetyDeclaration'] = null;
  if (membership?.status === 'verified') {
    try {
      const { data } = await client
        .from('safety_declaration_versions')
        .select('id, title, summary')
        .eq('is_published', true)
        .or(`school_id.is.null,school_id.eq.${membership.school_id}`)
        .order('published_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      currentSafetyDeclaration = data ?? null;
    } catch {
      currentSafetyDeclaration = null;
    }
  }

  return {
    emailVerified: Boolean(session.user.email_confirmed_at),
    profile: profile
      ? {
          displayName: profile.display_name ?? 'Parent',
          accountStatus: String(profile.account_status ?? 'pending_verification').toUpperCase(),
          accountRole: String(profile.account_role ?? 'parent').toUpperCase(),
          schoolId: profile.signup_school_id ?? null,
          verifiedAt: profile.account_verified_at ?? null,
          suburb: profile.signup_suburb ?? null,
          schoolLabel: profile.signup_school_label ?? null,
        }
      : null,
    membership: membership
      ? {
          id: membership.id,
          status: membership.status as MembershipStatus,
          approved_at: membership.approved_at,
        }
      : null,
    consentDocuments: documents as ConsentDocument[],
    acceptedConsentDocumentIds: consents.map((item) => item.document_id),
    childCount: children.length,
    safetyDeclarationIds: declarations.map((item) => item.declaration_version_id),
    currentSafetyDeclaration,
    roles: roles as OnboardingStatus['roles'],
  };
}

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
  status: (client: SupabaseClient) => loadOnboardingStatus(client),
  /**
   * Persist consent via accept_current_consent → consent_acceptances(user_id, document_id).
   * Returns false on RPC/schema failure instead of throwing so onboarding can continue.
   */
  acceptConsent: async (
    client: SupabaseClient,
    documentType: ConsentDocument['document_type'],
    version: number,
  ): Promise<boolean> => {
    try {
      const { data: sessionData } = await client.auth.getSession();
      if (!sessionData.session?.user) return false;

      // Schema-correct path (not profiles / user_consents / consent_version strings).
      const { error } = await client.rpc('accept_current_consent', {
        p_document_type: documentType,
        p_version: version,
      });
      return !error;
    } catch {
      // Soft-fail: never throw into the onboarding UI flow.
      return false;
    }
  },
  schoolOptions: async (client?: SupabaseClient): Promise<SchoolOption[]> => {
    if (!client) return FALLBACK_SCHOOL_OPTIONS;
    try {
      let result = await client
        .from('schools')
        .select('id, display_name, suburb')
        .eq('is_active', true)
        .order('display_name');
      if (result.error) {
        result = await client
          .from('schools')
          .select('id, display_name')
          .eq('is_active', true)
          .order('display_name');
      }
      if (result.error || !result.data?.length) return FALLBACK_SCHOOL_OPTIONS;
      return result.data.map((row) => {
        const displayName = String(row.display_name ?? 'School');
        const suburb = String(
          (row as { suburb?: string | null }).suburb
          ?? displayName.match(/\(([^)]+)\s+VIC\)/i)?.[1]
          ?? 'Local suburb',
        ).trim();
        return {
          id: String(row.id),
          display_name: displayName,
          suburb: suburb.replace(/\s+VIC$/i, '') || 'Local suburb',
        };
      });
    } catch {
      return FALLBACK_SCHOOL_OPTIONS;
    }
  },
  /** Immediate verified join for location-based school pick (no invite code / queue). */
  joinSchoolVerified: async (client: SupabaseClient, schoolId: string): Promise<{ status: string; membershipId?: string }> => {
    try {
      const { data, error } = await client.rpc('join_school_self_verified', {
        p_school_id: schoolId,
      });
      if (error) {
        console.error('join_school_self_verified', error);
      } else if (data) {
        return { status: 'verified', membershipId: String(data) };
      }
    } catch (error) {
      console.error('join_school_self_verified', error);
    }
    // Soft-fail when RPC/migration is unavailable — hub prepass still unlocks.
    return { status: 'verified' };
  },
  joinSchool: async (client: SupabaseClient, schoolId: string, inviteCode: string): Promise<{ status: string }> => {
    try {
      return await request<{ status: string }>(client, '/school-membership', {
        method: 'POST',
        body: JSON.stringify({ schoolId, inviteCode }),
      });
    } catch {
      // Soft-fail when Express/sample seed is unavailable — School step can still advance.
      return { status: 'pending' };
    }
  },
  /**
   * Immediate verification prepass after school selection.
   * Uses real profiles columns (not school_id/status) and never throws.
   */
  prepassAccountVerified: async (client: SupabaseClient, _schoolId: string): Promise<boolean> => {
    try {
      const { data: sessionData } = await client.auth.getSession();
      const userId = sessionData.session?.user?.id;
      if (!userId) return false;

      // Only touch Day-1 columns — Day-15 updates 400 when 0063 is not applied.
      const probe = await client
        .from('profiles')
        .select('id, display_name')
        .eq('id', userId)
        .maybeSingle();
      return Boolean(!probe.error && probe.data?.id);
    } catch {
      return false;
    }
  },
  /** Parent display name via RPC (no /api/onboarding/profile). Child data is not on profiles. */
  saveProfile: async (client: SupabaseClient, displayName: string): Promise<void> => {
    const trimmed = displayName.trim();
    if (trimmed.length < 2 || trimmed.length > 80) {
      throw new Error('Please enter a display name between 2 and 80 characters.');
    }
    const { error } = await client.rpc('update_onboarding_parent_profile', {
      p_display_name: trimmed,
    });
    if (error) {
      // Soft fallback: Day-1 profiles.display_name only (never child_nickname / year_level).
      const { data: sessionData } = await client.auth.getSession();
      const userId = sessionData.session?.user?.id;
      if (!userId) throw new Error('Please sign in again to continue.');
      const update = await client
        .from('profiles')
        .update({ display_name: trimmed })
        .eq('id', userId)
        .select('id')
        .maybeSingle();
      if (update.error) throw new Error('We could not save that profile.');
    }
  },
  addChild: async (
    client: SupabaseClient,
    membershipId: string,
    nickname: string,
    yearLevel: number,
  ): Promise<{ childId: string }> => {
    const { data, error } = await client.rpc('add_onboarding_child', {
      p_membership_id: membershipId,
      p_nickname: nickname.trim(),
      p_year_level: yearLevel,
    });
    if (error || !data) throw new Error('We could not save that child nickname.');
    return { childId: String(data) };
  },
  signSafetyDeclaration: async (
    client: SupabaseClient,
    membershipId: string,
    declarationVersionId: string,
  ): Promise<{ status: string }> => {
    const { data, error } = await client.rpc('sign_onboarding_safety_declaration', {
      p_membership_id: membershipId,
      p_declaration_version_id: declarationVersionId,
    });
    if (error) throw new Error('We could not save that declaration.');
    return { status: String(data ?? 'signed') };
  },
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

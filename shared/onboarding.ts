export const ANALYTICS_EVENT_IDS = [
  'signed_up',
  'email_verified',
  'school_joined',
  'approved',
  'child_added',
  'declaration_signed',
  'invite_sent',
  'invite_joined',
  'first_listing_created',
  'first_trip_completed',
] as const;

export type AnalyticsEventId = (typeof ANALYTICS_EVENT_IDS)[number];
export type MembershipStatus = 'pending_email' | 'pending_invite' | 'pending_moderator' | 'pending' | 'verified' | 'rejected' | 'suspended';

export function isPendingMembership(status: MembershipStatus | null | undefined): boolean {
  return Boolean(status?.startsWith('pending'));
}

export function onboardingAccessState(input: {
  membershipStatus: MembershipStatus | null;
  hasCurrentConsents: boolean;
  hasChild: boolean;
  hasSafetyDeclaration: boolean;
  accountStatus?: string | null;
}): 'account' | 'consent' | 'school' | 'waiting' | 'profile-and-safety' | 'ready' | 'rejected' | 'suspended' {
  const accountStatus = String(input.accountStatus ?? '').trim().toUpperCase();
  if (accountStatus === 'REJECTED' || input.membershipStatus === 'rejected') return 'rejected';
  if (input.membershipStatus === 'suspended') return 'suspended';
  // Pending verification / pending membership no longer hard-lock the hub —
  // show a soft welcome banner in UI instead of the waiting screen.
  if (!input.hasCurrentConsents) return 'consent';
  if (!input.membershipStatus) return 'school';
  if (!input.hasChild || !input.hasSafetyDeclaration) return 'profile-and-safety';
  return 'ready';
}

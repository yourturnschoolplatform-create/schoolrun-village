import { describe, expect, it } from 'vitest';
import { ANALYTICS_EVENT_IDS, isPendingMembership, onboardingAccessState } from '../../shared/onboarding.js';

describe('onboarding and schedule state transitions', () => {
  it('allows only the explicit onboarding, listing and first-trip IDs-only analytics event names', () => {
    expect(ANALYTICS_EVENT_IDS).toEqual([
      'signed_up', 'email_verified', 'school_joined', 'approved',
      'child_added', 'declaration_signed', 'invite_sent', 'invite_joined', 'first_listing_created',
      'first_trip_completed',
    ]);
    expect(ANALYTICS_EVENT_IDS).not.toContain('location_updated');
    expect(ANALYTICS_EVENT_IDS).not.toContain('payment_created');
  });

  it('treats pending membership as soft — continues onboarding instead of a hard waiting lock', () => {
    expect(isPendingMembership('pending')).toBe(true);
    expect(isPendingMembership('pending_email')).toBe(true);
    expect(isPendingMembership('pending_invite')).toBe(true);
    expect(isPendingMembership('pending_moderator')).toBe(true);
    expect(isPendingMembership('verified')).toBe(false);
    expect(onboardingAccessState({ membershipStatus: 'pending', hasCurrentConsents: true, hasChild: false, hasSafetyDeclaration: false })).toBe('profile-and-safety');
    expect(onboardingAccessState({ membershipStatus: 'pending', hasCurrentConsents: true, hasChild: true, hasSafetyDeclaration: true })).toBe('ready');
  });

  it('requires approval, child profile and safety declaration before ready access', () => {
    expect(onboardingAccessState({ membershipStatus: null, hasCurrentConsents: false, hasChild: false, hasSafetyDeclaration: false })).toBe('consent');
    expect(onboardingAccessState({ membershipStatus: null, hasCurrentConsents: true, hasChild: false, hasSafetyDeclaration: false })).toBe('school');
    expect(onboardingAccessState({ membershipStatus: 'verified', hasCurrentConsents: true, hasChild: false, hasSafetyDeclaration: false })).toBe('profile-and-safety');
    expect(onboardingAccessState({ membershipStatus: 'verified', hasCurrentConsents: true, hasChild: true, hasSafetyDeclaration: true })).toBe('ready');
  });

  it('continues to block rejected and suspended memberships', () => {
    expect(onboardingAccessState({ membershipStatus: 'rejected', hasCurrentConsents: true, hasChild: true, hasSafetyDeclaration: true })).toBe('rejected');
    expect(onboardingAccessState({ membershipStatus: 'suspended', hasCurrentConsents: true, hasChild: true, hasSafetyDeclaration: true })).toBe('suspended');
  });
});

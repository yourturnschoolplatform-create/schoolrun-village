export const TRUST_POLICY_DEFAULTS = {
  version: 1,
  startScore: 70,
  bands: {
    trusted: 85,
    standard: 60,
    caution: 40,
    restricted: 20,
    suspendedBelow: 20,
  },
  changes: {
    completedTrip: 1,
    urgentCover: 3,
    cancelUnder24Hours: -3,
    cancelUnder2Hours: -8,
    lateWithAdvanceNotice: -2,
    lateWithoutAdvanceNotice: -5,
    confirmedNoShow: -20,
    confirmedNoShowWithBackup: -10,
    confirmedFalseReport: -15,
    reviewedSafetyViolation: -25,
  },
  confirmedNoShowTripsOwed: 2,
  urgentCover: {
    postedWithinHours: 4,
    weeklyLimit: 2,
    sameHouseholdAllowed: false,
  },
} as const;

export type TrustBand = 'Trusted' | 'Standard' | 'Caution' | 'Restricted' | 'Suspended';

export function trustBandFor(score: number, adminSuspended = false): TrustBand {
  if (adminSuspended || score < TRUST_POLICY_DEFAULTS.bands.suspendedBelow) return 'Suspended';
  if (score >= TRUST_POLICY_DEFAULTS.bands.trusted) return 'Trusted';
  if (score >= TRUST_POLICY_DEFAULTS.bands.standard) return 'Standard';
  if (score >= TRUST_POLICY_DEFAULTS.bands.caution) return 'Caution';
  return 'Restricted';
}

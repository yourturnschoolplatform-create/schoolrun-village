/** Care Credits & Village Helper tiers — non-monetary Instant Pickup rewards. */

export type CareHelperTier = 'community' | 'silver' | 'gold';

export type CareCreditWallet = {
  careCredits: number;
  completedRidesProvided: number;
  prioritySosPasses: number;
  helperTier: CareHelperTier;
  ridesToNextTier: number;
  ridesToNextSosPass: number;
};

export const DEFAULT_CARE_WALLET: CareCreditWallet = {
  careCredits: 2,
  completedRidesProvided: 0,
  prioritySosPasses: 0,
  helperTier: 'community',
  ridesToNextTier: 5,
  ridesToNextSosPass: 3,
};

export function normalizeCareWallet(raw: Partial<CareCreditWallet> | null | undefined): CareCreditWallet {
  const careCredits = Math.max(0, Number(raw?.careCredits) || 0);
  const completedRidesProvided = Math.max(0, Number(raw?.completedRidesProvided) || 0);
  const prioritySosPasses = Math.max(0, Number(raw?.prioritySosPasses) || 0);
  const helperTier = careHelperTier(completedRidesProvided);
  return {
    careCredits,
    completedRidesProvided,
    prioritySosPasses,
    helperTier,
    ridesToNextTier: ridesToNextHelperTier(completedRidesProvided),
    ridesToNextSosPass: completedRidesProvided === 0
      ? 3
      : (3 - (completedRidesProvided % 3) || 3),
  };
}

export function careHelperTier(ridesProvided: number): CareHelperTier {
  if (ridesProvided >= 12) return 'gold';
  if (ridesProvided >= 5) return 'silver';
  return 'community';
}

export function careHelperTierLabel(tier: CareHelperTier): string {
  if (tier === 'gold') return 'Gold Helper';
  if (tier === 'silver') return 'Silver Helper';
  return 'Community Helper';
}

export function ridesToNextHelperTier(ridesProvided: number): number {
  if (ridesProvided >= 12) return 0;
  if (ridesProvided >= 5) return Math.max(0, 12 - ridesProvided);
  return Math.max(0, 5 - ridesProvided);
}

export function feeWaiverProgressCopy(wallet: CareCreditWallet): string {
  if (wallet.helperTier === 'gold') {
    return 'Gold Helper unlocked — Marketplace & Hot Deal fee waivers active.';
  }
  if (wallet.helperTier === 'silver') {
    return `${wallet.ridesToNextTier} more ride${wallet.ridesToNextTier === 1 ? '' : 's'} to Gold Helper fee waiver.`;
  }
  return `${wallet.ridesToNextTier} more ride${wallet.ridesToNextTier === 1 ? '' : 's'} to Silver Helper fee waiver.`;
}

export function buildSchoolInviteShareUrl(origin = ''): string {
  const base = origin || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}/?view=today&invite=school`;
}

export function formatSchoolInviteShareText(walletCredits: number): string {
  return [
    'Join me on SchoolRun Village — Instant Pickup for our school.',
    'Verified school parents both earn +1 Care Credit.',
    `I currently have ${walletCredits} Care Credit${walletCredits === 1 ? '' : 's'}.`,
    buildSchoolInviteShareUrl(),
  ].join('\n');
}

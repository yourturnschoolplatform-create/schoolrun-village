import { describe, expect, it } from 'vitest';
import {
  careHelperTier,
  careHelperTierLabel,
  feeWaiverProgressCopy,
  formatSchoolInviteShareText,
  normalizeCareWallet,
  ridesToNextHelperTier,
} from '../../shared/care-credits';

describe('care credits helpers', () => {
  it('maps helper tiers and fee-waiver progress in English', () => {
    expect(careHelperTier(0)).toBe('community');
    expect(careHelperTier(5)).toBe('silver');
    expect(careHelperTier(12)).toBe('gold');
    expect(careHelperTierLabel('silver')).toBe('Silver Helper');
    expect(ridesToNextHelperTier(3)).toBe(2);
    expect(feeWaiverProgressCopy(normalizeCareWallet({
      careCredits: 2,
      completedRidesProvided: 3,
      prioritySosPasses: 0,
    }))).toContain('Silver Helper');
  });

  it('builds English school invite share copy with Care Credit reward', () => {
    const text = formatSchoolInviteShareText(2);
    expect(text).toContain('Care Credit');
    expect(text).toContain('SchoolRun Village');
    expect(text).toMatch(/invite=school|view=today/);
  });
});

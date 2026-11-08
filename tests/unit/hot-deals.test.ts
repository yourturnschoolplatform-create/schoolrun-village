import { describe, expect, it } from 'vitest';
import {
  dealProgressCopy,
  dealProgressPercent,
  formatDealAskAud,
  HOT_DEALS_CATALOGUE,
  validatePartnerInquiry,
} from '../../shared/hot-deals';

describe('Hot Deals and Partner Hub helpers', () => {
  it('formats exclusive AUD asks and group progress copy', () => {
    expect(formatDealAskAud(5900)).toBe('$59 AUD');
    expect(dealProgressPercent(42, 50)).toBe(84);
    expect(dealProgressCopy({
      joinedCount: 42,
      targetCount: 50,
      bonusDiscountAudCents: 1500,
    })).toContain('42/50 joined');
    expect(HOT_DEALS_CATALOGUE.length).toBeGreaterThanOrEqual(3);
  });

  it('validates partner inquiry fields for B2B onboarding', () => {
    expect(validatePartnerInquiry({
      businessName: 'Harbour Kids Co.',
      contactEmail: 'hello@harbourkids.com.au',
      contactNumber: '0399998888',
      category: 'Goods Deal',
      proposedTerms: '12% cohort exclusive rate',
      message: 'We can supply lunchboxes for Term 2.',
    })).toBeNull();
    expect(validatePartnerInquiry({
      businessName: 'A',
      contactEmail: 'bad',
      contactNumber: '',
      category: 'Sponsorship',
      proposedTerms: 'short',
      message: 'hi',
    })).toMatch(/business name|email|terms|message/i);
  });
});

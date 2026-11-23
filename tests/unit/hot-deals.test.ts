import { describe, expect, it } from 'vitest';
import {
  dealProgressCopy,
  dealProgressPercent,
  formatDealAskAud,
  HOT_DEALS_CATALOGUE,
  normalizeHotDeal,
  validateHotDealUpsert,
  validatePartnerInquiry,
} from '../../shared/hot-deals';
import { buildHotDealSharePayload } from '../../src/lib/hot-deal-share';

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
    expect(HOT_DEALS_CATALOGUE[0]?.description?.length).toBeGreaterThan(20);
  });

  it('normalizes media fields and validates admin upsert payloads', () => {
    const normalized = normalizeHotDeal({
      id: 'deal-test',
      title: 'Test deal',
      summary: 'Short summary',
      description: 'Detailed product description for parents.',
      brandName: 'Test Brand',
      brandMark: 'TB',
      category: 'School & Nursery',
      originalAskAudCents: 5000,
      groupAskAudCents: 3000,
      joinedCount: 1,
      targetCount: 10,
      bonusDiscountAudCents: 500,
      ctaLabel: 'Join Group Buy',
      dealImages: [{ src: 'data:image/jpeg;base64,abc', cover: true }],
      videoUrl: 'https://example.com/clip.mp4',
    });
    expect(normalized.dealImages).toHaveLength(1);
    expect(normalized.videoUrl).toContain('https://');
    expect(validateHotDealUpsert({
      ...normalized,
      description: normalized.description || '',
      dealImages: normalized.dealImages || [],
      videoUrl: normalized.videoUrl || null,
    })).toBeNull();
    expect(buildHotDealSharePayload(normalized).url).toContain('panel=deals');
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

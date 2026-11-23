import { describe, expect, it } from 'vitest';
import {
  buildListingSharePayload,
  buildListingShareUrl,
  listingSharePriceLabel,
} from '../../src/lib/listing-share';
import {
  buildSmsShareHref,
  buildWhatsAppShareHref,
  formatDiscussionShareClipboard,
} from '../../src/lib/discussion-share';

describe('listing share helpers', () => {
  it('builds a direct marketplace listing URL', () => {
    const url = buildListingShareUrl('11111111-1111-4111-8111-111111111111');
    expect(url).toContain('view=community');
    expect(url).toContain('panel=market');
    expect(url).toContain('listing=11111111-1111-4111-8111-111111111111');
  });

  it('formats AUD price and trade labels in English', () => {
    expect(listingSharePriceLabel({
      listingKind: 'sale',
      askAudCents: 4500,
    })).toBe('$45 AUD');
    expect(listingSharePriceLabel({
      listingKind: 'swap',
      displayOfferLabel: 'SWAP',
    })).toBe('Swap');
    expect(listingSharePriceLabel({
      listingKind: 'giveaway',
      displayOfferLabel: 'FREE',
    })).toBe('Free Share');
  });

  it('builds English share text with title, price, suburb and link helpers', () => {
    const payload = buildListingSharePayload({
      listingId: '11111111-1111-4111-8111-111111111111',
      title: 'Kids bike (size 16")',
      listingKind: 'sale',
      askAudCents: 8000,
      suburb: 'Richmond',
    });
    expect(payload.title).toContain('Kids bike');
    expect(payload.text).toContain('$80 AUD');
    expect(payload.text).toContain('Pickup area: Richmond');
    expect(payload.text).toContain('SchoolRun Village Marketplace');
    expect(payload.url).toContain('listing=11111111-1111-4111-8111-111111111111');
    expect(formatDiscussionShareClipboard(payload)).toContain(payload.url);
    expect(buildSmsShareHref(payload)).toMatch(/^sms:\?body=/);
    expect(buildWhatsAppShareHref(payload)).toMatch(/^https:\/\/wa\.me\/\?text=/);
  });
});

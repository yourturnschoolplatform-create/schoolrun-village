import { describe, expect, it } from 'vitest';
import {
  buildCheckoutBreakdown,
  buyNowLabel,
  isInAppPayableListing,
  joinAndPayLabel,
  NON_PAYMENT_HANDOVER_COPY,
  nonPaymentNoticeForTrade,
  paymentTrackForListingKind,
  PICKUP_NO_SHOW_POLICY_COPY,
} from '../../shared/payment-tracks';

describe('dual-track payment policy', () => {
  it('routes sale to in-app and free/swap to non-payment', () => {
    expect(paymentTrackForListingKind('sale')).toBe('in_app');
    expect(paymentTrackForListingKind('giveaway')).toBe('non_payment');
    expect(paymentTrackForListingKind('swap')).toBe('non_payment');
    expect(isInAppPayableListing('sale')).toBe(true);
    expect(isInAppPayableListing('free_share')).toBe(false);
  });

  it('builds platform service breakdown for checkout', () => {
    const breakdown = buildCheckoutBreakdown(5000);
    expect(breakdown.itemAskAudCents).toBe(5000);
    expect(breakdown.platformServiceAudCents).toBe(400);
    expect(breakdown.totalAudCents).toBe(5400);
    expect(breakdown.itemAskDisplay).toBe('$50 AUD');
    expect(breakdown.totalDisplay).toBe('$54 AUD');
    expect(buyNowLabel(4500)).toBe('Buy Now ($45 AUD)');
    expect(joinAndPayLabel(5900)).toBe('Join & Pay ($59 AUD)');
  });

  it('states non-payment handover and pickup no-show trust notices', () => {
    expect(nonPaymentNoticeForTrade('free_share')).toContain(NON_PAYMENT_HANDOVER_COPY);
    expect(nonPaymentNoticeForTrade('swap')).toContain(NON_PAYMENT_HANDOVER_COPY);
    expect(nonPaymentNoticeForTrade('pickup_dropoff')).toContain(NON_PAYMENT_HANDOVER_COPY);
    expect(PICKUP_NO_SHOW_POLICY_COPY).toMatch(/trust/i);
    expect(PICKUP_NO_SHOW_POLICY_COPY).toMatch(/school-donation/i);
  });
});

import { formatAudCents, type MarketplaceListingKind, type MarketplaceTradeType } from './marketplace';
import { TRUST_POLICY_DEFAULTS } from './trust-policy';

/** Dual-track settlement policy for marketplace, Hot Deals and school-run help. */
export type PaymentTrack = 'non_payment' | 'in_app';

export type CheckoutMethod = 'stripe_card' | 'payid';

export type CheckoutBreakdown = {
  itemAskAudCents: number;
  platformServiceAudCents: number;
  totalAudCents: number;
  platformRateBps: number;
  itemAskDisplay: string;
  platformServiceDisplay: string;
  totalDisplay: string;
};

/** Platform service rate in basis points (800 = 8%). Display-only mock checkout. */
export const PLATFORM_SERVICE_RATE_BPS = 800;

export const NON_PAYMENT_HANDOVER_COPY =
  'No In-App Payment required (Arrange directly or school-gate handover).';

export const IN_APP_PAYMENT_COPY =
  'Secure SchoolRun Village in-app payment available (Stripe card or PayID). Platform service is shown at checkout.';

export const PICKUP_NO_SHOW_POLICY_COPY =
  `Confirmed no-shows reduce Parent Trust by ${TRUST_POLICY_DEFAULTS.changes.confirmedNoShow} `
  + `(or ${TRUST_POLICY_DEFAULTS.changes.confirmedNoShowWithBackup} with backup) and may trigger `
  + `${TRUST_POLICY_DEFAULTS.confirmedNoShowTripsOwed} school-donation trip notices. `
  + 'No cash is handled in SchoolRun Village for pickup or drop-off.';

export function paymentTrackForListingKind(kind: MarketplaceListingKind | MarketplaceTradeType): PaymentTrack {
  if (kind === 'sale') return 'in_app';
  return 'non_payment';
}

export function isInAppPayableListing(kind: MarketplaceListingKind | MarketplaceTradeType): boolean {
  return paymentTrackForListingKind(kind) === 'in_app';
}

export function nonPaymentNoticeForTrade(trade: MarketplaceTradeType | 'pickup_dropoff'): string {
  if (trade === 'pickup_dropoff') {
    return `${NON_PAYMENT_HANDOVER_COPY} ${PICKUP_NO_SHOW_POLICY_COPY}`;
  }
  if (trade === 'free_share') {
    return `Free Share (Relay): ${NON_PAYMENT_HANDOVER_COPY}`;
  }
  if (trade === 'swap') {
    return `Swap / Barter: ${NON_PAYMENT_HANDOVER_COPY}`;
  }
  return NON_PAYMENT_HANDOVER_COPY;
}

/** Build checkout lines for Sell listings and Hot Deals group-buys. */
export function buildCheckoutBreakdown(itemAskAudCents: number): CheckoutBreakdown {
  const ask = Math.max(0, Math.round(itemAskAudCents));
  const platformServiceAudCents = Math.max(0, Math.round((ask * PLATFORM_SERVICE_RATE_BPS) / 10_000));
  const totalAudCents = ask + platformServiceAudCents;
  return {
    itemAskAudCents: ask,
    platformServiceAudCents,
    totalAudCents,
    platformRateBps: PLATFORM_SERVICE_RATE_BPS,
    itemAskDisplay: formatAudCents(ask) ?? '$0 AUD',
    platformServiceDisplay: formatAudCents(platformServiceAudCents) ?? '$0 AUD',
    totalDisplay: formatAudCents(totalAudCents) ?? '$0 AUD',
  };
}

export function buyNowLabel(askAudCents: number | null | undefined): string {
  const display = formatAudCents(askAudCents);
  return display ? `Buy Now (${display})` : 'Buy Now ($AUD)';
}

export function joinAndPayLabel(askAudCents: number | null | undefined): string {
  const display = formatAudCents(askAudCents);
  return display ? `Join & Pay (${display})` : 'Join & Pay';
}

export function checkoutMethodLabel(method: CheckoutMethod): string {
  return method === 'payid' ? 'PayID' : 'Stripe card';
}

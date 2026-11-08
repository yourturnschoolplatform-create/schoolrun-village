import {
  buildCheckoutBreakdown,
  type CheckoutBreakdown,
  type CheckoutMethod,
} from '../../shared/payment-tracks';

export type PaymentIntentInput = {
  listingId: string;
  title: string;
  itemAskAudCents: number;
  method: CheckoutMethod;
  kind: 'marketplace_sale' | 'hot_deal';
};

export type PaymentIntentResult = {
  ok: true;
  intentId: string;
  method: CheckoutMethod;
  breakdown: CheckoutBreakdown;
  status: 'requires_confirmation' | 'succeeded';
  receiptNote: string;
};

/**
 * Mock Stripe / PayID gateway hooks for the monetised in-app track.
 * Replace createPaymentIntent / confirmPaymentIntent with live gateway SDKs later.
 */
export const paymentGateway = {
  async createPaymentIntent(input: PaymentIntentInput): Promise<PaymentIntentResult> {
    await delay(280);
    if (!input.listingId || input.itemAskAudCents < 100) {
      throw new Error('That paid item needs a valid AUD ask before checkout.');
    }
    const breakdown = buildCheckoutBreakdown(input.itemAskAudCents);
    return {
      ok: true,
      intentId: `pi_mock_${input.kind}_${Date.now().toString(36)}`,
      method: input.method,
      breakdown,
      status: 'requires_confirmation',
      receiptNote: `${input.title} · ${breakdown.totalDisplay} incl. platform service`,
    };
  },

  async confirmPaymentIntent(intent: PaymentIntentResult): Promise<PaymentIntentResult> {
    await delay(420);
    return {
      ...intent,
      status: 'succeeded',
      receiptNote: `Paid via ${intent.method === 'payid' ? 'PayID' : 'Stripe'} · ${intent.breakdown.totalDisplay}`,
    };
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

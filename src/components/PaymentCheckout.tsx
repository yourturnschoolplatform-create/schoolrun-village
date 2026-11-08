import { useMemo, useState } from 'react';
import {
  buildCheckoutBreakdown,
  checkoutMethodLabel,
  IN_APP_PAYMENT_COPY,
  type CheckoutMethod,
} from '../../shared/payment-tracks';
import { paymentGateway } from '../lib/payment-gateway';

export type PaymentCheckoutRequest = {
  listingId: string;
  title: string;
  itemAskAudCents: number;
  kind: 'marketplace_sale' | 'hot_deal';
  primaryLabel: string;
};

/**
 * Dual-track monetised checkout: Stripe card / PayID mock with fee breakdown.
 */
export function PaymentCheckout({
  request,
  onClose,
  onPaid,
}: {
  request: PaymentCheckoutRequest | null;
  onClose: () => void;
  onPaid: (receipt: string) => void;
}) {
  const [method, setMethod] = useState<CheckoutMethod>('stripe_card');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const breakdown = useMemo(
    () => (request ? buildCheckoutBreakdown(request.itemAskAudCents) : null),
    [request],
  );

  if (!request || !breakdown) return null;

  async function confirm() {
    const active = request;
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      const intent = await paymentGateway.createPaymentIntent({
        listingId: active.listingId,
        title: active.title,
        itemAskAudCents: active.itemAskAudCents,
        method,
        kind: active.kind,
      });
      const paid = await paymentGateway.confirmPaymentIntent(intent);
      onPaid(paid.receiptNote);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Checkout could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="partner-hub-overlay" role="presentation" onClick={onClose}>
      <section
        className="partner-hub-modal payment-checkout"
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-checkout-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="partner-hub-modal__head">
          <div>
            <p className="eyebrow">Secure checkout</p>
            <h2 id="payment-checkout-title">{request.primaryLabel}</h2>
            <p className="section-copy">{request.title}</p>
          </div>
          <button type="button" className="text-button" onClick={onClose}>Close</button>
        </div>

        <p className="notice notice--teal" role="status">{IN_APP_PAYMENT_COPY}</p>

        <ul className="payment-checkout__lines" aria-label="Checkout breakdown">
          <li>
            <span>Item ask</span>
            <strong>{breakdown.itemAskDisplay}</strong>
          </li>
          <li>
            <span>SchoolRun Village service ({(breakdown.platformRateBps / 100).toFixed(0)}%)</span>
            <strong>{breakdown.platformServiceDisplay}</strong>
          </li>
          <li className="payment-checkout__total">
            <span>Total due</span>
            <strong>{breakdown.totalDisplay}</strong>
          </li>
        </ul>

        <fieldset className="payment-checkout__methods">
          <legend>Payment method</legend>
          <label className={method === 'stripe_card' ? 'payment-method payment-method--active' : 'payment-method'}>
            <input
              type="radio"
              name="checkout-method"
              checked={method === 'stripe_card'}
              onChange={() => setMethod('stripe_card')}
            />
            <span>
              <strong>Stripe card</strong>
              <small>Mock card gateway for paid marketplace &amp; Hot Deals</small>
            </span>
          </label>
          <label className={method === 'payid' ? 'payment-method payment-method--active' : 'payment-method'}>
            <input
              type="radio"
              name="checkout-method"
              checked={method === 'payid'}
              onChange={() => setMethod('payid')}
            />
            <span>
              <strong>PayID</strong>
              <small>Australian bank PayID mock transfer</small>
            </span>
          </label>
        </fieldset>

        {error ? <p className="notice notice--red" role="alert">{error}</p> : null}

        <button
          type="button"
          className="commercial-cta"
          disabled={busy}
          onClick={() => void confirm()}
        >
          {busy
            ? `Processing ${checkoutMethodLabel(method)}…`
            : `Confirm ${checkoutMethodLabel(method)} · ${breakdown.totalDisplay}`}
        </button>
      </section>
    </div>
  );
}

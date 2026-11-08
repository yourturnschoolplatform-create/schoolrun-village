import { useMemo, useState } from 'react';
import {
  dealProgressCopy,
  dealProgressPercent,
  formatDealAskAud,
  HOT_DEALS_CATALOGUE,
  type HotDeal,
} from '../../shared/hot-deals';
import { IN_APP_PAYMENT_COPY, joinAndPayLabel } from '../../shared/payment-tracks';
import { PaymentCheckout, type PaymentCheckoutRequest } from './PaymentCheckout';

const JOIN_STORAGE_KEY = 'yourturn.hot-deal-joins';

function readJoinedIds(): string[] {
  try {
    const raw = window.localStorage.getItem(JOIN_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function writeJoinedIds(ids: string[]) {
  try {
    window.localStorage.setItem(JOIN_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* ignore quota */
  }
}

/**
 * School-parent Hot Deals feed: group-buy progress + in-app Join & Pay checkout.
 */
export function HotDealsBoard({
  onBecomePartner,
}: {
  onBecomePartner: () => void;
}) {
  const [joinedIds, setJoinedIds] = useState<string[]>(() => (
    typeof window === 'undefined' ? [] : readJoinedIds()
  ));
  const [toast, setToast] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<PaymentCheckoutRequest | null>(null);

  const deals = useMemo(() => HOT_DEALS_CATALOGUE.map((deal) => {
    const joined = joinedIds.includes(deal.id);
    return {
      ...deal,
      joinedCount: deal.joinedCount + (joined ? 1 : 0),
      viewerJoined: joined,
    };
  }), [joinedIds]);

  function openJoinPay(deal: HotDeal & { viewerJoined: boolean }) {
    if (deal.viewerJoined) {
      setToast('You have already joined this group buy.');
      return;
    }
    setCheckout({
      listingId: deal.id,
      title: deal.title,
      itemAskAudCents: deal.groupAskAudCents,
      kind: 'hot_deal',
      primaryLabel: joinAndPayLabel(deal.groupAskAudCents),
    });
  }

  function markJoined(dealId: string, receipt: string) {
    const next = joinedIds.includes(dealId) ? joinedIds : [...joinedIds, dealId];
    setJoinedIds(next);
    writeJoinedIds(next);
    setToast(receipt);
  }

  return (
    <section className="feed-section hot-deals-board" aria-labelledby="hot-deals-title">
      <div className="feed-section__intro">
        <p className="eyebrow">Hot Deals</p>
        <h2 id="hot-deals-title">Exclusive group buys for your school.</h2>
        <p className="section-copy">
          Monetised in-app track: Join &amp; Pay with Stripe or PayID. Platform service is shown at checkout.
        </p>
      </div>

      <p className="notice notice--teal" role="status">{IN_APP_PAYMENT_COPY}</p>

      <div className="hot-deals-promo-slider" aria-label="Partner promotions">
        <article className="hot-deals-promo-slide">
          <strong>School cohort savings</strong>
          <p>Join verified parents at your school for exclusive merchant rates this term.</p>
        </article>
        <article className="hot-deals-promo-slide hot-deals-promo-slide--accent">
          <strong>Local brands welcome</strong>
          <p>Goods deals, tutoring packs and sponsorships — apply via Partner Hub.</p>
          <button type="button" className="commercial-cta" onClick={onBecomePartner}>
            Become a Partner
          </button>
        </article>
      </div>

      {toast ? <p className="notice notice--teal marketplace-toast" role="status">{toast}</p> : null}

      <ul className="feed-list hot-deals-list">
        {deals.map((deal) => {
          const percent = dealProgressPercent(deal.joinedCount, deal.targetCount);
          return (
            <li key={deal.id} className="feed-card hot-deal-card">
              <div className="hot-deal-card__brand" aria-hidden="true">
                <span className="hot-deal-card__mark">{deal.brandMark}</span>
                <span className="hot-deal-card__thumb">{deal.category.split(' ')[0]}</span>
              </div>
              <div className="hot-deal-card__body">
                <div className="feed-card__top">
                  <div>
                    <p className="hot-deal-card__brand-name">{deal.brandName}</p>
                    <strong>{deal.title}</strong>
                  </div>
                  <div className="hot-deal-card__asks">
                    <span className="hot-deal-card__ask-original">{formatDealAskAud(deal.originalAskAudCents)}</span>
                    <span className="hot-deal-card__ask-group">{formatDealAskAud(deal.groupAskAudCents)}</span>
                  </div>
                </div>
                <p className="feed-card__body">{deal.summary}</p>
                <p className="hot-deal-card__progress-copy">{dealProgressCopy(deal)}</p>
                <div
                  className="hot-deal-card__progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  aria-label={`${deal.joinedCount} of ${deal.targetCount} parents joined`}
                >
                  <span style={{ width: `${percent}%` }} />
                </div>
                <div className="feed-card__actions">
                  <button
                    type="button"
                    className="commercial-cta feed-card__cta"
                    disabled={deal.viewerJoined}
                    onClick={() => openJoinPay(deal)}
                  >
                    {deal.viewerJoined ? 'Paid & joined' : joinAndPayLabel(deal.groupAskAudCents)}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <PaymentCheckout
        request={checkout}
        onClose={() => setCheckout(null)}
        onPaid={(receipt) => {
          const dealId = checkout?.listingId;
          if (dealId) markJoined(dealId, receipt);
        }}
      />
    </section>
  );
}

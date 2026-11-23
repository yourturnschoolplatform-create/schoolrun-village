import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  dealProgressCopy,
  dealProgressPercent,
  formatDealAskAud,
  type HotDeal,
} from '../../shared/hot-deals';
import { coverListingImage } from '../../shared/marketplace';
import { IN_APP_PAYMENT_COPY, joinAndPayLabel } from '../../shared/payment-tracks';
import { hotDealsApi } from '../lib/hot-deals-api';
import { HotDealDetail } from './HotDealDetail';
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
 * School-parent Hot Deals feed: media cards, detail modal, Save / Share / Join & Pay.
 */
export function HotDealsBoard({
  client = null,
  onBecomePartner,
  initialDealId = null,
}: {
  client?: SupabaseClient | null;
  onBecomePartner: () => void;
  initialDealId?: string | null;
}) {
  const [catalogue, setCatalogue] = useState<HotDeal[]>([]);
  const [joinedIds, setJoinedIds] = useState<string[]>(() => (
    typeof window === 'undefined' ? [] : readJoinedIds()
  ));
  const [toast, setToast] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<PaymentCheckoutRequest | null>(null);
  const [selected, setSelected] = useState<HotDeal | null>(null);
  const [saveBusyId, setSaveBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await hotDealsApi.list(client);
    setCatalogue(next);
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!initialDealId || !catalogue.length) return;
    const match = catalogue.find((deal) => deal.id === initialDealId);
    if (match) setSelected(match);
  }, [catalogue, initialDealId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const deals = useMemo(() => catalogue.map((deal) => {
    const joined = joinedIds.includes(deal.id);
    return {
      ...deal,
      joinedCount: deal.joinedCount + (joined ? 1 : 0),
      viewerJoined: joined,
    };
  }), [catalogue, joinedIds]);

  function openJoinPay(deal: HotDeal & { viewerJoined?: boolean }) {
    if (deal.viewerJoined) {
      setToast('You have already joined this group buy.');
      return;
    }
    setSelected(null);
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

  async function toggleSave(deal: HotDeal) {
    if (saveBusyId) return;
    setSaveBusyId(deal.id);
    try {
      const result = await hotDealsApi.toggleSave(client, deal.id);
      setCatalogue((current) => current.map((entry) => (
        entry.id === deal.id ? { ...entry, viewerHasSaved: result.saved } : entry
      )));
      setSelected((current) => (
        current && current.id === deal.id
          ? { ...current, viewerHasSaved: result.saved }
          : current
      ));
      setToast(result.saved ? 'Saved' : 'Removed from saved Hot Deals');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'That save could not be updated.');
    } finally {
      setSaveBusyId(null);
    }
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
          const cover = coverListingImage(deal.dealImages);
          return (
            <li key={deal.id} className="feed-card hot-deal-card">
              <button
                type="button"
                className="hot-deal-card__hit"
                onClick={() => setSelected(deal)}
                aria-label={`Open ${deal.title} Hot Deal details`}
              >
                <div className="hot-deal-card__brand" aria-hidden="true">
                  <span className="hot-deal-card__mark">{deal.brandMark}</span>
                  {cover ? (
                    <img className="hot-deal-card__photo" src={cover.src} alt="" />
                  ) : deal.videoUrl ? (
                    <span className="hot-deal-card__thumb hot-deal-card__thumb--video">Video</span>
                  ) : (
                    <span className="hot-deal-card__thumb">{deal.category.split(' ')[0]}</span>
                  )}
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
                </div>
              </button>
              <div className="feed-card__actions hot-deal-card__actions">
                <button
                  type="button"
                  className="commercial-cta feed-card__cta"
                  disabled={deal.viewerJoined}
                  onClick={() => openJoinPay(deal)}
                >
                  {deal.viewerJoined ? 'Paid & joined' : joinAndPayLabel(deal.groupAskAudCents)}
                </button>
                <button
                  type="button"
                  className="secondary-button feed-card__cta"
                  onClick={() => setSelected(deal)}
                >
                  View details
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {selected ? (
        <HotDealDetail
          deal={deals.find((deal) => deal.id === selected.id) ?? selected}
          busy={saveBusyId === selected.id}
          onClose={() => setSelected(null)}
          onSave={(deal) => { void toggleSave(deal); }}
          onJoinPay={openJoinPay}
          onShareFeedback={setToast}
        />
      ) : null}

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

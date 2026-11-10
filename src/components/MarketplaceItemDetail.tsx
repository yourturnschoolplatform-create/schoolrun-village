import { useEffect, useId } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  formatSchoolLocationChip,
  resolveSchoolLocation,
  statusLabelEnglish,
} from '../../shared/au-location';
import { formatAudCents, tradeBadgeLabel } from '../../shared/marketplace';
import { isOwnListing } from '../../shared/listing-create';
import {
  buyNowLabel,
  isInAppPayableListing,
  NON_PAYMENT_HANDOVER_COPY,
} from '../../shared/payment-tracks';
import type { ItemListing } from '../lib/listings-api';
import { ListingImageCarousel } from './ListingImageCarousel';
import { ParentTrustBadge } from './ParentTrustBadge';

/**
 * Karrot-style listing detail sheet: carousel, seller trust, sticky chat CTA.
 */
export function MarketplaceItemDetail({
  client,
  userId,
  item,
  busy,
  favoriteBusy = false,
  onClose,
  onChat,
  onToggleFavorite,
  onBuyNow,
}: {
  client: SupabaseClient;
  userId: string;
  item: ItemListing;
  busy: boolean;
  favoriteBusy?: boolean;
  onClose: () => void;
  onChat: (listing: ItemListing) => void;
  onToggleFavorite: (listing: ItemListing) => void;
  onBuyNow: (listing: ItemListing) => void;
}) {
  const titleId = useId();
  const ownListing = isOwnListing(item.author_id, userId);
  const location = resolveSchoolLocation({
    displayName: item.schoolDisplayName || 'Your school',
    suburb: item.schoolSuburb,
    schoolSector: item.schoolSector,
  });
  const badge = tradeBadgeLabel(item.display_offer_label, item.listing_kind);
  const rawAsk = item.askAudDisplay || formatAudCents(item.askAudCents);
  const askDisplay = rawAsk && !/\bAUD\b/i.test(rawAsk) ? `${rawAsk} AUD` : rawAsk;
  const payable = isInAppPayableListing(item.listing_kind) && (item.askAudCents ?? 0) > 0;
  const favorited = Boolean(item.viewerHasFavorited);
  const favoriteCount = item.favoriteCount ?? 0;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="karrot-detail-overlay" role="presentation" onClick={onClose}>
      <aside
        className="karrot-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="karrot-detail__top">
          <button type="button" className="text-button" onClick={onClose}>Close</button>
          <span className="karrot-detail__status">{statusLabelEnglish(item.status)}</span>
        </div>

        <div className="karrot-detail__media">
          <ListingImageCarousel images={item.listingImages} title={item.title} />
        </div>

        <div className="karrot-detail__seller">
          <ParentTrustBadge
            client={client}
            peerUserId={item.author_id}
            displayName={item.author_display_name}
            band={item.authorParentTrustBand || item.authorTrustBand}
            suburb={location.suburb}
          />
          <p className="karrot-detail__place">{formatSchoolLocationChip(location)}</p>
        </div>

        <div className="karrot-detail__copy">
          <p className="karrot-detail__price">
            {askDisplay ?? (badge === 'SWAP' ? 'Swap' : 'Free Share')}
          </p>
          <h3 id={titleId}>{item.title}</h3>
          <p className="karrot-detail__category">
            {item.category}
            {item.itemCondition ? ` · ${item.itemCondition}` : ''}
            {item.sizeAgeLabel ? ` · ${item.sizeAgeLabel}` : ''}
          </p>
          <p className="karrot-detail__body">{item.description}</p>
          {(item.householdEnv ?? []).length ? (
            <p className="karrot-detail__env">{(item.householdEnv ?? []).join(' · ')}</p>
          ) : null}
        </div>

        <div className="karrot-detail__bar">
          {ownListing ? (
            <p className="field-help">
              This is your own listing
              {favoriteCount > 0 ? ` · ${favoriteCount} favourites` : ''}.
            </p>
          ) : (
            <>
              <button
                type="button"
                className={
                  favorited
                    ? 'karrot-detail__heart karrot-detail__heart--on'
                    : 'karrot-detail__heart'
                }
                disabled={busy || favoriteBusy}
                aria-pressed={favorited}
                aria-label={favorited ? 'Remove from favourites' : 'Add to favourites'}
                title={favorited ? 'Favourited' : 'Favourite'}
                onClick={() => onToggleFavorite(item)}
              >
                <span aria-hidden="true">{favorited ? '♥' : '♡'}</span>
                {favoriteCount > 0 ? (
                  <span className="karrot-detail__heart-count">{favoriteCount}</span>
                ) : null}
              </button>
              <button
                type="button"
                className="karrot-detail__chat"
                disabled={busy}
                onClick={() => void onChat(item)}
              >
                Chat 1:1
              </button>
              {payable ? (
                <button
                  type="button"
                  className="karrot-detail__buy"
                  disabled={busy}
                  onClick={() => onBuyNow(item)}
                >
                  {buyNowLabel(item.askAudCents)}
                </button>
              ) : null}
            </>
          )}
          {!ownListing && !payable ? (
            <p className="field-help karrot-detail__hint">{NON_PAYMENT_HANDOVER_COPY}</p>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

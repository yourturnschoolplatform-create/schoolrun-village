import {
  formatSchoolLocationChip,
  resolveSchoolLocation,
  statusLabelEnglish,
} from '../../shared/au-location';
import {
  coverListingImage,
  formatAudCents,
  tradeBadgeLabel,
} from '../../shared/marketplace';
import type { ItemListing } from '../lib/listings-api';
import { MarketplaceShareButton } from './MarketplaceShareButton';

function relativeTimeAu(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 60) return 'Just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

function priceLabel(item: ItemListing): { text: string; tone: 'sale' | 'free' | 'swap' } {
  const badge = tradeBadgeLabel(item.display_offer_label, item.listing_kind);
  const rawAsk = item.askAudDisplay || formatAudCents(item.askAudCents);
  if (rawAsk) {
    const text = /\bAUD\b/i.test(rawAsk) ? rawAsk : `${rawAsk} AUD`;
    return { text, tone: 'sale' };
  }
  if (badge === 'SWAP') return { text: 'Swap', tone: 'swap' };
  return { text: 'Free Share', tone: 'free' };
}

/**
 * Karrot-style feed row with suburb, distance, and Same school badge.
 */
export function MarketplaceItemCard({
  item,
  favoriteBusy = false,
  canFavorite = true,
  onOpen,
  onToggleFavorite,
  onShareFeedback,
}: {
  item: ItemListing;
  favoriteBusy?: boolean;
  canFavorite?: boolean;
  onOpen: (listing: ItemListing) => void;
  onToggleFavorite?: (listing: ItemListing) => void;
  onShareFeedback?: (message: string) => void;
}) {
  const cover = coverListingImage(item.listingImages);
  const areaLabel = (item.areaLabel || item.schoolSuburb || 'Local suburb').trim();
  const location = resolveSchoolLocation({
    displayName: item.schoolDisplayName || 'Your school',
    suburb: areaLabel,
    schoolSector: item.schoolSector,
  });
  const price = priceLabel(item);
  const when = relativeTimeAu(item.created_at);
  const favorited = Boolean(item.viewerHasFavorited);
  const favoriteCount = item.favoriteCount ?? 0;
  const distanceLabel = item.distanceKm != null && Number.isFinite(item.distanceKm)
    ? `${item.distanceKm.toFixed(1)} km`
    : null;

  return (
    <article className="karrot-card">
      <button
        type="button"
        className="karrot-card__hit"
        onClick={() => onOpen(item)}
        aria-label={`${item.title}. ${price.text}. ${areaLabel}${distanceLabel ? ` ${distanceLabel}` : ''}`}
      >
        <div className="karrot-card__thumb" aria-hidden={!cover && !item.videoUrl}>
          {cover ? (
            <img src={cover.src} alt="" className="karrot-card__image" />
          ) : item.videoUrl ? (
            <video
              className="karrot-card__image karrot-card__video"
              src={item.videoUrl}
              muted
              playsInline
              preload="metadata"
              aria-hidden="true"
            />
          ) : (
            <span className="karrot-card__placeholder">No photo</span>
          )}
          {item.videoUrl ? (
            <span className="karrot-card__video-badge">Video</span>
          ) : null}
          {item.sameSchool ? (
            <span className="karrot-card__school-badge">Same school</span>
          ) : null}
        </div>
        <div className="karrot-card__body">
          <p className="karrot-card__title">{item.title}</p>
          <p className="karrot-card__meta">
            <span>{areaLabel}</span>
            {distanceLabel ? <span aria-hidden="true"> · </span> : null}
            {distanceLabel ? <span>{distanceLabel}</span> : null}
            {when ? <span aria-hidden="true"> · </span> : null}
            {when ? <time dateTime={item.created_at}>{when}</time> : null}
          </p>
          <div className="karrot-card__footer">
            <span
              className={
                price.tone === 'sale'
                  ? 'karrot-card__price'
                  : price.tone === 'free'
                    ? 'karrot-card__price karrot-card__price--free'
                    : 'karrot-card__price karrot-card__price--swap'
              }
            >
              {price.text}
            </span>
            <span className="karrot-card__status">{statusLabelEnglish(item.status)}</span>
          </div>
          <p className="karrot-card__place">{formatSchoolLocationChip(location)}</p>
        </div>
      </button>
      <div className="karrot-card__interest">
        <MarketplaceShareButton
          listingId={item.id}
          title={item.title}
          listingKind={item.listing_kind}
          displayOfferLabel={item.display_offer_label}
          askAudCents={item.askAudCents}
          askAudDisplay={item.askAudDisplay}
          suburb={areaLabel}
          compact
          stopPropagation
          onFeedback={onShareFeedback}
        />
        <button
          type="button"
          className={
            favorited
              ? 'karrot-card__heart karrot-card__heart--on'
              : 'karrot-card__heart'
          }
          disabled={!canFavorite || favoriteBusy || !onToggleFavorite}
          aria-pressed={favorited}
          aria-label={favorited ? 'Remove from favourites' : 'Add to favourites'}
          title={favorited ? 'Favourited' : 'Favourite'}
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite?.(item);
          }}
        >
          <span aria-hidden="true">{favorited ? '♥' : '♡'}</span>
          {favoriteCount > 0 ? (
            <span className="karrot-card__heart-count">{favoriteCount}</span>
          ) : null}
        </button>
      </div>
    </article>
  );
}

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
 * Karrot-style home feed row: square thumb left, title / suburb / time / price right.
 * Heart toggles listing_favorites via parent handler.
 */
export function MarketplaceItemCard({
  item,
  favoriteBusy = false,
  canFavorite = true,
  onOpen,
  onToggleFavorite,
}: {
  item: ItemListing;
  favoriteBusy?: boolean;
  canFavorite?: boolean;
  onOpen: (listing: ItemListing) => void;
  onToggleFavorite?: (listing: ItemListing) => void;
}) {
  const cover = coverListingImage(item.listingImages);
  const location = resolveSchoolLocation({
    displayName: item.schoolDisplayName || 'Your school',
    suburb: item.schoolSuburb,
    schoolSector: item.schoolSector,
  });
  const price = priceLabel(item);
  const suburb = location.suburb.trim() || 'Local suburb';
  const when = relativeTimeAu(item.created_at);
  const favorited = Boolean(item.viewerHasFavorited);
  const favoriteCount = item.favoriteCount ?? 0;

  return (
    <article className="karrot-card">
      <button
        type="button"
        className="karrot-card__hit"
        onClick={() => onOpen(item)}
        aria-label={`${item.title}. ${price.text}. ${suburb}`}
      >
        <div className="karrot-card__thumb" aria-hidden={!cover}>
          {cover ? (
            <img src={cover.src} alt="" className="karrot-card__image" />
          ) : (
            <span className="karrot-card__placeholder">No photo</span>
          )}
        </div>
        <div className="karrot-card__body">
          <p className="karrot-card__title">{item.title}</p>
          <p className="karrot-card__meta">
            <span>{suburb}</span>
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

import { formatAudCents, tradeBadgeLabel, type MarketplaceListingKind } from '../../shared/marketplace';
import type { DiscussionSharePayload } from './discussion-share';

export type ListingSharePayload = DiscussionSharePayload;

/** Direct SPA URL that opens Marketplace focused on this listing. */
export function buildListingShareUrl(listingId: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const params = new URLSearchParams({
    view: 'community',
    panel: 'market',
    listing: listingId,
  });
  return `${origin}/?${params.toString()}`;
}

export function listingSharePriceLabel(input: {
  listingKind: MarketplaceListingKind;
  displayOfferLabel?: string | null;
  askAudCents?: number | null;
  askAudDisplay?: string | null;
}): string {
  const badge = tradeBadgeLabel(input.displayOfferLabel ?? '', input.listingKind);
  const rawAsk = (input.askAudDisplay || formatAudCents(input.askAudCents) || '').trim();
  if (rawAsk) {
    return /\bAUD\b/i.test(rawAsk) ? rawAsk : `${rawAsk} AUD`;
  }
  if (badge === 'SWAP') return 'Swap';
  return 'Free Share';
}

export function buildListingSharePayload(input: {
  listingId: string;
  title: string;
  listingKind: MarketplaceListingKind;
  displayOfferLabel?: string | null;
  askAudCents?: number | null;
  askAudDisplay?: string | null;
  suburb?: string | null;
}): ListingSharePayload {
  const title = (input.title || 'Marketplace listing').trim().slice(0, 120);
  const price = listingSharePriceLabel(input);
  const suburb = (input.suburb || '').trim();
  const lines = [
    title,
    price,
    suburb ? `Pickup area: ${suburb}` : null,
    'Listed on SchoolRun Village Marketplace',
  ].filter(Boolean) as string[];

  return {
    title,
    text: lines.join('\n'),
    url: buildListingShareUrl(input.listingId),
  };
}

export {
  buildSmsShareHref,
  buildWhatsAppShareHref,
  copyTextToClipboard,
  formatDiscussionShareClipboard as formatListingShareClipboard,
  tryNativeShare,
} from './discussion-share';

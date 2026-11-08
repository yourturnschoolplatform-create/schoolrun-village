import {
  normalizeListingImages,
  type ListingImagePayload,
  type MarketplaceCondition,
  type MarketplaceHouseholdEnv,
  type MarketplaceListingKind,
} from './marketplace';

export type CreateListingInput = {
  kind: MarketplaceListingKind;
  title: string;
  description: string;
  category: string;
  offerLabel: string;
  askAudCents?: number | null;
  listingImages?: ListingImagePayload[] | null;
  itemCondition?: MarketplaceCondition | null;
  sizeAgeLabel?: string | null;
  householdEnv?: MarketplaceHouseholdEnv[] | null;
};

/**
 * Align create payload with migration 0061/0062 RPC args.
 * Optional fields fall back to null / empty arrays so NOT NULL defaults never trip.
 */
export function buildCreateItemListingArgs(input: CreateListingInput): Record<string, unknown> {
  const images = normalizeListingImages(input.listingImages ?? []);
  const householdEnv = (input.householdEnv ?? []).filter(
    (entry): entry is MarketplaceHouseholdEnv => entry === 'Smoke-free' || entry === 'Pet-free',
  );
  const condition = input.itemCondition && ['New', 'Like New', 'Good'].includes(input.itemCondition)
    ? input.itemCondition
    : null;
  const sizeAge = input.sizeAgeLabel?.trim() ? input.sizeAgeLabel.trim().slice(0, 40) : null;

  return {
    p_listing_kind: input.kind,
    p_title: input.title.trim(),
    p_description: input.description.trim(),
    p_category: input.category.trim(),
    p_display_offer_label: input.offerLabel.trim(),
    p_ask_aud_cents: input.askAudCents ?? null,
    p_listing_images: images,
    p_item_condition: condition,
    p_size_age_label: sizeAge,
    p_household_env: householdEnv,
  };
}

export function friendlyListingCreateError(raw: string | null | undefined): string {
  const text = (raw ?? '').toLowerCase();
  if (!text) return 'That listing could not be posted. Please try again.';
  if (text.includes('ask') || text.includes('aud')) {
    return 'Sell listings need a valid AUD ask (for example 50).';
  }
  if (text.includes('image')) {
    return 'Listing images must be up to six compressed images with one cover selected.';
  }
  if (text.includes('phone') || text.includes('email') || text.includes('photo') || text.includes('full name')) {
    return 'Listing text must stay phone-free, email-free and child-name-free.';
  }
  if (text.includes('restricted')) {
    return 'That item matches a restricted catalogue entry and cannot be listed.';
  }
  if (text.includes('condition')) {
    return 'Choose a condition: New, Like New, or Good.';
  }
  if (text.includes('membership') || text.includes('verified') || text.includes('permission') || text.includes('jwt')) {
    return 'Marketplace posting needs a verified school membership. Finish onboarding, then try again.';
  }
  if (text.includes('could not find the function') || text.includes('pgrst202') || text.includes('404')) {
    return 'Marketplace create is updating. Run npm run db:migrate, then refresh and try again.';
  }
  return 'That listing could not be posted. Please check the details and try again.';
}

/** Own-listing / 400 mapping for enquire + listing chat RPCs. */
export function friendlyListingContactError(
  raw: string | null | undefined,
  action: 'enquire' | 'chat' = 'enquire',
): string {
  const text = (raw ?? '').toLowerCase();
  if (
    text.includes('own listing')
    || text.includes('their own listing')
    || text.includes('with themselves')
    || text.includes('authors cannot')
  ) {
    return 'This is your own listing.';
  }
  if (text.includes('unavailable') || text.includes('42501')) {
    return 'That listing is not available for contact right now.';
  }
  if (text.includes('phone') || text.includes('email') || text.includes('photo') || text.includes('full name')) {
    return 'Enquiry text must stay phone-free, email-free and child-name-free.';
  }
  if (text.includes('400') || text.includes('22p02') || text.includes('invalid input')) {
    return action === 'chat'
      ? 'Chat could not open for that listing. Refresh and try again.'
      : 'That enquiry could not be sent. Refresh and try again.';
  }
  return action === 'chat'
    ? 'Chat with that parent is not available right now. Try Enquire instead.'
    : 'That enquiry could not be sent right now.';
}

export function isOwnListing(authorId: string | null | undefined, viewerUserId: string | null | undefined): boolean {
  return Boolean(authorId && viewerUserId && authorId === viewerUserId);
}

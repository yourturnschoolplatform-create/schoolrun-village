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
  /** Suburb-only meetup label for neighbourhood discovery. */
  areaLabel?: string | null;
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

  const areaLabel = input.areaLabel?.trim() ? input.areaLabel.trim().slice(0, 64) : null;

  const askCents = input.askAudCents == null
    ? null
    : Math.round(Number(input.askAudCents));

  return {
    p_listing_kind: input.kind,
    p_title: input.title.trim(),
    p_description: input.description.trim(),
    p_category: input.category.trim(),
    p_display_offer_label: input.offerLabel.trim(),
    // Whole AUD cents integer (e.g. 5000 for $50). Never send dollars here.
    p_ask_aud_cents: askCents != null && Number.isFinite(askCents) ? askCents : null,
    p_listing_images: images,
    p_item_condition: condition,
    p_size_age_label: sizeAge,
    // jsonb array — keep as a plain array for PostgREST
    p_household_env: householdEnv,
    p_area_label: areaLabel,
  };
}

export function friendlyListingCreateError(raw: string | null | undefined): string {
  const original = (raw ?? '').trim();
  const text = original.toLowerCase();
  if (!text) return 'That listing could not be posted. Please try again.';

  // Never treat PostgREST signature misses as an AUD ask failure (messages often
  // list p_ask_aud_cents in the "could not find function" details).
  if (
    text.includes('could not find the function')
    || text.includes('pgrst202')
    || text.includes('pgrst203')
    || text.includes('schema cache')
  ) {
    return original || 'Marketplace create is updating. Run npm run db:migrate, then refresh and try again.';
  }

  if (
    text.includes('aud ask between')
    || text.includes('need an aud ask')
    || text.includes('send cents')
  ) {
    return 'Sell listings need a valid AUD ask of at least $1 (for example 50).';
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
  if (text.includes('suburb')) {
    return 'Choose a suburb-only meetup label for neighbourhood pickup.';
  }
  if (text.includes('membership') || text.includes('verified') || text.includes('42501') || text.includes('jwt')) {
    return 'Marketplace posting needs a verified school membership. Finish onboarding, then try again.';
  }

  // Prefer the real Postgres / Supabase message over a generic mask.
  if (original.length > 0 && original.length < 280) {
    return original;
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

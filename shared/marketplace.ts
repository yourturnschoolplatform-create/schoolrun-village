/** Australian school marketplace constants. Ask amounts are AUD cents for Sell only. */

export const MARKETPLACE_CATEGORIES = [
  'Baby & Toddler Gear',
  'Toys & Outdoor',
  'Kids Fashion & Shoes',
  'Books & Learning',
  'School & Nursery',
] as const;

export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];

export type MarketplaceTradeType = 'sale' | 'free_share' | 'swap';

export type MarketplaceListingKind = 'giveaway' | 'lending' | 'sale' | 'swap';

export const MARKETPLACE_TRADE_FILTERS: Array<{ id: 'all' | MarketplaceTradeType; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'sale', label: 'Sell' },
  { id: 'free_share', label: 'Free Share (Relay)' },
  { id: 'swap', label: 'Swap / Barter' },
];

export const MARKETPLACE_CATEGORY_FILTERS: Array<{ id: 'all' | MarketplaceCategory; label: string }> = [
  { id: 'all', label: 'All' },
  ...MARKETPLACE_CATEGORIES.map((category) => ({ id: category, label: category })),
];

/** Whole AUD dollars → cents. Returns null when empty/invalid. */
export function audDollarsToCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

/** Format stored AUD cents for cards, e.g. 5000 → "$50 AUD". */
export function formatAudCents(cents: number | null | undefined): string | null {
  if (cents == null || !Number.isFinite(cents) || cents <= 0) return null;
  const dollars = cents / 100;
  if (Number.isInteger(dollars)) return `$${dollars} AUD`;
  return `$${dollars.toFixed(2)} AUD`;
}

export function tradeTypeToListingKind(trade: MarketplaceTradeType): MarketplaceListingKind {
  if (trade === 'sale') return 'sale';
  if (trade === 'swap') return 'swap';
  return 'giveaway';
}

export function listingKindToTradeType(kind: MarketplaceListingKind): MarketplaceTradeType {
  if (kind === 'sale') return 'sale';
  if (kind === 'swap') return 'swap';
  return 'free_share';
}

export function offerLabelForTrade(trade: MarketplaceTradeType): 'SALE' | 'FREE' | 'SWAP' {
  if (trade === 'sale') return 'SALE';
  if (trade === 'swap') return 'SWAP';
  return 'FREE';
}

export function tradeBadgeLabel(offerLabel: string, kind: MarketplaceListingKind): string {
  const upper = offerLabel.trim().toUpperCase();
  if (upper === 'SALE' || kind === 'sale') return 'SALE';
  if (upper === 'SWAP' || kind === 'swap') return 'SWAP';
  return 'FREE';
}

export function isMarketplaceCategory(value: string): value is MarketplaceCategory {
  return (MARKETPLACE_CATEGORIES as readonly string[]).includes(value);
}

/** Quick-spec condition chips shown on create + cards. */
export const MARKETPLACE_CONDITIONS = ['New', 'Like New', 'Good'] as const;
export type MarketplaceCondition = (typeof MARKETPLACE_CONDITIONS)[number];

/** Size / age chips for kids goods. */
export const MARKETPLACE_SIZE_AGE_OPTIONS = [
  '0–6 months',
  '6–12 months',
  '1–2 years',
  '3–4 years',
  'Size 4',
  'Size 6',
  'Size 8',
  'Size 10',
  'Size 12',
  'One size',
] as const;
export type MarketplaceSizeAge = (typeof MARKETPLACE_SIZE_AGE_OPTIONS)[number];

/** Household environment multi-select chips. */
export const MARKETPLACE_HOUSEHOLD_ENV = ['Smoke-free', 'Pet-free'] as const;
export type MarketplaceHouseholdEnv = (typeof MARKETPLACE_HOUSEHOLD_ENV)[number];

export type ListingImagePayload = {
  src: string;
  cover: boolean;
};

export function isMarketplaceCondition(value: string): value is MarketplaceCondition {
  return (MARKETPLACE_CONDITIONS as readonly string[]).includes(value);
}

export function isMarketplaceHouseholdEnv(value: string): value is MarketplaceHouseholdEnv {
  return (MARKETPLACE_HOUSEHOLD_ENV as readonly string[]).includes(value);
}

/** Ensure exactly one cover when images exist; first image wins if none marked. */
export function normalizeListingImages(
  images: Array<{ src: string; cover?: boolean }>,
): ListingImagePayload[] {
  const trimmed = images
    .map((entry) => ({ src: entry.src.trim(), cover: Boolean(entry.cover) }))
    .filter((entry) => entry.src.length > 0)
    .slice(0, 6);
  if (trimmed.length === 0) return [];
  const coverIndex = trimmed.findIndex((entry) => entry.cover);
  return trimmed.map((entry, index) => ({
    src: entry.src,
    cover: coverIndex >= 0 ? index === coverIndex : index === 0,
  }));
}

export function coverListingImage(
  images: ListingImagePayload[] | null | undefined,
): ListingImagePayload | null {
  if (!images?.length) return null;
  return images.find((entry) => entry.cover) ?? images[0] ?? null;
}

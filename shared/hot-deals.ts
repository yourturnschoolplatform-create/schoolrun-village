/** Curated AU school Hot Deals catalogue. Ask amounts are AUD cents (display only). */

import type { ListingImagePayload } from './marketplace';
import { normalizeListingImages } from './marketplace';

export type HotDeal = {
  id: string;
  brandName: string;
  brandMark: string;
  title: string;
  summary: string;
  /** Longer product copy shown in the detail modal. */
  description?: string;
  category: string;
  originalAskAudCents: number;
  groupAskAudCents: number;
  joinedCount: number;
  targetCount: number;
  bonusDiscountAudCents: number;
  ctaLabel: 'Join Group Buy' | 'Buy Deal';
  dealImages?: ListingImagePayload[] | null;
  videoUrl?: string | null;
  status?: 'active' | 'hidden' | 'archived';
  viewerHasSaved?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type HotDealUpsertInput = {
  id?: string | null;
  brandName: string;
  brandMark: string;
  title: string;
  summary: string;
  description: string;
  category: string;
  originalAskAudCents: number;
  groupAskAudCents: number;
  joinedCount: number;
  targetCount: number;
  bonusDiscountAudCents: number;
  ctaLabel: 'Join Group Buy' | 'Buy Deal';
  dealImages: ListingImagePayload[];
  videoUrl: string | null;
  status?: 'active' | 'hidden' | 'archived';
};

export const HOT_DEALS_CATALOGUE: HotDeal[] = [
  {
    id: 'deal-lunchbox-pack',
    brandName: 'Harbour Kids Co.',
    brandMark: 'HK',
    title: 'Insulated lunchbox 3-pack',
    summary: 'Leak-proof school lunchboxes with name-label window. School-gate pickup week.',
    description:
      'Three insulated lunchboxes with leak-proof seals and a clear name-label window. Ideal for primary lunch routines. School-gate pickup window confirmed after the group unlocks.',
    category: 'School & Nursery',
    originalAskAudCents: 8900,
    groupAskAudCents: 5900,
    joinedCount: 42,
    targetCount: 50,
    bonusDiscountAudCents: 1500,
    ctaLabel: 'Join Group Buy',
    dealImages: [],
    videoUrl: null,
  },
  {
    id: 'deal-swim-rashie',
    brandName: 'Coastal Swim AU',
    brandMark: 'CS',
    title: 'UPF50+ rashie bundle',
    summary: 'Sizes 4–12. Exclusive parent group rate for verified school households.',
    description:
      'UPF50+ rashie bundle covering sizes 4–12. Soft stretch fabric for active kids, with an exclusive verified-parent group rate for this school term.',
    category: 'Kids Fashion & Shoes',
    originalAskAudCents: 5400,
    groupAskAudCents: 3600,
    joinedCount: 28,
    targetCount: 40,
    bonusDiscountAudCents: 1000,
    ctaLabel: 'Join Group Buy',
    dealImages: [],
    videoUrl: null,
  },
  {
    id: 'deal-tutoring-trial',
    brandName: 'BrightPath Tutoring',
    brandMark: 'BP',
    title: 'After-school literacy trial (4 sessions)',
    summary: 'Local tutors for primary readers. Group booking unlocks the exclusive rate.',
    description:
      'Four after-school literacy sessions with local tutors focused on primary readers. Group booking unlocks the exclusive SchoolRun Village rate for verified households.',
    category: 'Local Class / Tutoring',
    originalAskAudCents: 22000,
    groupAskAudCents: 16000,
    joinedCount: 11,
    targetCount: 20,
    bonusDiscountAudCents: 2500,
    ctaLabel: 'Buy Deal',
    dealImages: [],
    videoUrl: null,
  },
  {
    id: 'deal-sports-socks',
    brandName: 'Pitch & Play',
    brandMark: 'PP',
    title: 'School sports sock 5-pack',
    summary: 'Durable white sports socks. Extra discount when the school cohort fills.',
    description:
      'A durable white school sports sock 5-pack for weekly PE and sports days. Extra discount unlocks when the school cohort fills.',
    category: 'Kids Fashion & Shoes',
    originalAskAudCents: 3200,
    groupAskAudCents: 1900,
    joinedCount: 47,
    targetCount: 60,
    bonusDiscountAudCents: 800,
    ctaLabel: 'Join Group Buy',
    dealImages: [],
    videoUrl: null,
  },
];

export function formatDealAskAud(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0) return '$0 AUD';
  const dollars = cents / 100;
  if (Number.isInteger(dollars)) return `$${dollars} AUD`;
  return `$${dollars.toFixed(2)} AUD`;
}

export function dealProgressPercent(joined: number, target: number): number {
  if (target <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((joined / target) * 100)));
}

export function dealProgressCopy(deal: Pick<HotDeal, 'joinedCount' | 'targetCount' | 'bonusDiscountAudCents'>): string {
  const remaining = Math.max(0, deal.targetCount - deal.joinedCount);
  if (remaining === 0) return `${deal.joinedCount}/${deal.targetCount} joined — group rate unlocked!`;
  return `${deal.joinedCount}/${deal.targetCount} joined for extra ${formatDealAskAud(deal.bonusDiscountAudCents)} discount!`;
}

export function normalizeHotDeal(raw: Partial<HotDeal> & Pick<HotDeal, 'id' | 'title'>): HotDeal {
  const images = normalizeListingImages(
    Array.isArray(raw.dealImages)
      ? raw.dealImages.map((entry) => ({
        src: typeof entry?.src === 'string' ? entry.src : '',
        cover: Boolean(entry?.cover),
      }))
      : [],
  );
  const video = typeof raw.videoUrl === 'string' && /^https:\/\//i.test(raw.videoUrl.trim())
    ? raw.videoUrl.trim()
    : null;
  return {
    id: raw.id,
    brandName: (raw.brandName || 'Partner brand').trim() || 'Partner brand',
    brandMark: (raw.brandMark || 'SR').trim().slice(0, 4) || 'SR',
    title: raw.title.trim(),
    summary: (raw.summary || '').trim() || raw.title.trim(),
    description: (raw.description || raw.summary || '').trim(),
    category: (raw.category || 'School & Nursery').trim(),
    originalAskAudCents: Math.max(0, Number(raw.originalAskAudCents) || 0),
    groupAskAudCents: Math.max(0, Number(raw.groupAskAudCents) || 0),
    joinedCount: Math.max(0, Number(raw.joinedCount) || 0),
    targetCount: Math.max(1, Number(raw.targetCount) || 1),
    bonusDiscountAudCents: Math.max(0, Number(raw.bonusDiscountAudCents) || 0),
    ctaLabel: raw.ctaLabel === 'Buy Deal' ? 'Buy Deal' : 'Join Group Buy',
    dealImages: images,
    videoUrl: video,
    status: raw.status === 'hidden' || raw.status === 'archived' ? raw.status : 'active',
    viewerHasSaved: Boolean(raw.viewerHasSaved),
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

export function validateHotDealUpsert(input: HotDealUpsertInput): string | null {
  if (input.brandName.trim().length < 2) return 'Add the partner or brand name.';
  if (input.title.trim().length < 3) return 'Add a deal title (at least 3 characters).';
  if (input.summary.trim().length < 3) return 'Add a short summary for the deal card.';
  if (input.description.trim().length < 8) return 'Add a detailed product description.';
  if (input.groupAskAudCents <= 0) return 'Add a deal AUD price greater than zero.';
  if (input.originalAskAudCents < input.groupAskAudCents) {
    return 'Original AUD price should be at least the deal price.';
  }
  if (input.targetCount < 1) return 'Group-buy target must be at least 1.';
  if (input.joinedCount < 0) return 'Joined count cannot be negative.';
  if (input.dealImages.length > 6) return 'You can attach up to 6 photos.';
  if (input.videoUrl && !/^https:\/\//i.test(input.videoUrl.trim())) {
    return 'Video URL must be a public https link.';
  }
  return null;
}

export const PARTNER_INQUIRY_CATEGORIES = [
  'Goods Deal',
  'Local Class/Tutoring',
  'Sponsorship',
] as const;

export type PartnerInquiryCategory = (typeof PARTNER_INQUIRY_CATEGORIES)[number];

export type PartnerInquiryInput = {
  businessName: string;
  contactEmail: string;
  contactNumber: string;
  category: PartnerInquiryCategory | string;
  proposedTerms: string;
  message: string;
};

export function validatePartnerInquiry(input: PartnerInquiryInput): string | null {
  if (input.businessName.trim().length < 2) return 'Add your business name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.contactEmail.trim())) {
    return 'Add a valid business contact email.';
  }
  const number = input.contactNumber.trim().replace(/\s/g, '');
  if (number && !/^(\+?61|0)\d{8,10}$/.test(number)) {
    return 'Use an Australian business contact number, or leave it blank.';
  }
  if (!(PARTNER_INQUIRY_CATEGORIES as readonly string[]).includes(input.category)) {
    return 'Choose a partner category.';
  }
  if (input.proposedTerms.trim().length < 8) {
    return 'Add a short proposed deal or commission note.';
  }
  if (input.message.trim().length < 8) {
    return 'Add a brief message for the partnerships team.';
  }
  return null;
}

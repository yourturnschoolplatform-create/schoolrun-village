/** Curated AU school Hot Deals catalogue. Ask amounts are AUD cents (display only). */

export type HotDeal = {
  id: string;
  brandName: string;
  brandMark: string;
  title: string;
  summary: string;
  category: string;
  originalAskAudCents: number;
  groupAskAudCents: number;
  joinedCount: number;
  targetCount: number;
  bonusDiscountAudCents: number;
  ctaLabel: 'Join Group Buy' | 'Buy Deal';
};

export const HOT_DEALS_CATALOGUE: HotDeal[] = [
  {
    id: 'deal-lunchbox-pack',
    brandName: 'Harbour Kids Co.',
    brandMark: 'HK',
    title: 'Insulated lunchbox 3-pack',
    summary: 'Leak-proof school lunchboxes with name-label window. School-gate pickup week.',
    category: 'School & Nursery',
    originalAskAudCents: 8900,
    groupAskAudCents: 5900,
    joinedCount: 42,
    targetCount: 50,
    bonusDiscountAudCents: 1500,
    ctaLabel: 'Join Group Buy',
  },
  {
    id: 'deal-swim-rashie',
    brandName: 'Coastal Swim AU',
    brandMark: 'CS',
    title: 'UPF50+ rashie bundle',
    summary: 'Sizes 4–12. Exclusive parent group rate for verified school households.',
    category: 'Kids Fashion & Shoes',
    originalAskAudCents: 5400,
    groupAskAudCents: 3600,
    joinedCount: 28,
    targetCount: 40,
    bonusDiscountAudCents: 1000,
    ctaLabel: 'Join Group Buy',
  },
  {
    id: 'deal-tutoring-trial',
    brandName: 'BrightPath Tutoring',
    brandMark: 'BP',
    title: 'After-school literacy trial (4 sessions)',
    summary: 'Local tutors for primary readers. Group booking unlocks the exclusive rate.',
    category: 'Local Class / Tutoring',
    originalAskAudCents: 22000,
    groupAskAudCents: 16000,
    joinedCount: 11,
    targetCount: 20,
    bonusDiscountAudCents: 2500,
    ctaLabel: 'Buy Deal',
  },
  {
    id: 'deal-sports-socks',
    brandName: 'Pitch & Play',
    brandMark: 'PP',
    title: 'School sports sock 5-pack',
    summary: 'Durable white sports socks. Extra discount when the school cohort fills.',
    category: 'Kids Fashion & Shoes',
    originalAskAudCents: 3200,
    groupAskAudCents: 1900,
    joinedCount: 47,
    targetCount: 60,
    bonusDiscountAudCents: 800,
    ctaLabel: 'Join Group Buy',
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

import type { MarketplaceCondition, MarketplaceHouseholdEnv, MarketplaceSizeAge } from './marketplace';

export type MarketplaceAiDraftInput = {
  itemName: string;
  condition: MarketplaceCondition | '';
  keyNotes: string;
  sizeAge?: MarketplaceSizeAge | '';
  householdEnv?: MarketplaceHouseholdEnv[];
  category?: string;
};

/**
 * Local AU marketplace description assistant (dual-mode Auto-Draft).
 * Formats a friendly, detailed listing without phones, URLs or child full names.
 */
export function generateMarketplaceAiDraft(input: MarketplaceAiDraftInput): string {
  const name = cleanLine(input.itemName) || 'This item';
  const condition = input.condition || 'Good';
  const notes = cleanLine(input.keyNotes);
  const sizeAge = cleanLine(input.sizeAge || '');
  const env = (input.householdEnv ?? []).filter(Boolean);
  const category = cleanLine(input.category || '');

  const opener = condition === 'New'
    ? `${name} is unused and ready for a new home at our school.`
    : condition === 'Like New'
      ? `${name} is in like-new condition — barely used and carefully looked after.`
      : `${name} is in good, everyday condition and ready for school-run pickup.`;

  const detailBits: string[] = [];
  if (category) detailBits.push(`Category: ${category}.`);
  if (sizeAge) detailBits.push(`Size / age: ${sizeAge}.`);
  detailBits.push(`Condition: ${condition}.`);
  if (env.length) detailBits.push(`From a ${env.join(', ').toLowerCase()} home.`);

  const noteLine = notes
    ? `Extra notes from the listing parent: ${notes}`
    : 'Happy to answer questions via SchoolRun Village chat before school-gate handover.';

  const closer = 'Pickup stays at school or a parent-agreed spot. Arrange details in SchoolRun Village chat only.';

  return [opener, detailBits.join(' '), noteLine, closer].filter(Boolean).join('\n\n');
}

function cleanLine(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/\b04\d{8}\b/g, '')
    .replace(/\+?61[\d\s]{8,}/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .trim()
    .slice(0, 400);
}

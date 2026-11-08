import { describe, expect, it } from 'vitest';
import { generateMarketplaceAiDraft } from '../../shared/marketplace-ai-draft';
import { normalizeListingImages, coverListingImage } from '../../shared/marketplace';

describe('marketplace AI draft and listing image helpers', () => {
  it('formats a friendly Australian English Auto-Draft without phones or URLs', () => {
    const draft = generateMarketplaceAiDraft({
      itemName: 'Size 8 sports shorts',
      condition: 'Like New',
      keyNotes: 'Worn twice. Elastic still firm.',
      sizeAge: 'Size 8',
      householdEnv: ['Smoke-free', 'Pet-free'],
      category: 'Kids Fashion & Shoes',
    });
    expect(draft).toContain('Size 8 sports shorts');
    expect(draft).toContain('like-new');
    expect(draft).toContain('Size / age: Size 8');
    expect(draft).toContain('smoke-free, pet-free');
    expect(draft).toContain('SchoolRun Village');
    expect(draft).not.toMatch(/https?:\/\//i);
    expect(draft).not.toMatch(/\b04\d{8}\b/);
  });

  it('normalises cover selection for up to six listing images', () => {
    const normalised = normalizeListingImages([
      { src: 'data:image/jpeg;base64,aaa', cover: false },
      { src: 'data:image/jpeg;base64,bbb', cover: true },
      { src: 'data:image/jpeg;base64,ccc', cover: true },
    ]);
    expect(normalised).toHaveLength(3);
    expect(normalised.filter((entry) => entry.cover)).toHaveLength(1);
    expect(normalised[1]?.cover).toBe(true);
    expect(coverListingImage(normalised)?.src).toContain('bbb');
  });
});

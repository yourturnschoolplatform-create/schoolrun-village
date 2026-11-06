import { describe, expect, it } from 'vitest';
import { childRevealAllowed, rankMatch, reciprocalDateAllowed, trustBand } from '../../shared/matching';

describe('Day 4 reciprocal matching rules', () => {
  it('keeps same-date reciprocity strict until the user opts into an allowed four-week date', () => {
    expect(reciprocalDateAllowed('2026-04-06', '2026-04-06', true, false, true, 28)).toBe(true);
    expect(reciprocalDateAllowed('2026-04-06', '2026-04-13', true, false, true, 28)).toBe(false);
    expect(reciprocalDateAllowed('2026-04-06', '2026-04-27', true, true, true, 28)).toBe(true);
    expect(reciprocalDateAllowed('2026-04-06', '2026-05-05', true, true, true, 28)).toBe(false);
  });
  it('returns only bands, never a numeric trust score', () => {
    expect(trustBand(85)).toBe('Trusted'); expect(trustBand(70)).toBe('Standard'); expect(trustBand(20)).toBe('Restricted'); expect(trustBand(19)).toBe('Suspended');
  });
  it('reveals child data only after acceptance to a participant', () => {
    expect(childRevealAllowed('proposed', true)).toBe(false); expect(childRevealAllowed('accepted', false)).toBe(false); expect(childRevealAllowed('accepted', true)).toBe(true);
  });
  it('ranks coarse-area and overlap quality before lower-ranked candidates', () => {
    expect(rankMatch({ overlap: 10, sameArea: true, band: 'Standard' }, { overlap: 20, sameArea: false, band: 'Trusted' })).toBeLessThan(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  parentTrustLabelForBand,
  parentTrustLabelForScore,
  parentTrustTone,
} from '../../shared/parent-trust';

describe('AU parent trust band labels', () => {
  it('maps engine bands to Bronze / Silver / Gold presentation labels', () => {
    expect(parentTrustLabelForBand('Trusted')).toBe('Gold Guardian');
    expect(parentTrustLabelForBand('Standard')).toBe('Silver Partner');
    expect(parentTrustLabelForBand('Caution')).toBe('Bronze Parent');
    expect(parentTrustLabelForBand('Restricted')).toBe('Bronze Parent');
    expect(parentTrustLabelForBand('Suspended')).toBe('Suspended');
    expect(parentTrustTone('Gold Guardian')).toBe('gold');
    expect(parentTrustTone('Silver Partner')).toBe('silver');
    expect(parentTrustTone('Bronze Parent')).toBe('bronze');
  });

  it('derives labels from score thresholds without exposing the number in the label', () => {
    expect(parentTrustLabelForScore(90)).toBe('Gold Guardian');
    expect(parentTrustLabelForScore(70)).toBe('Silver Partner');
    expect(parentTrustLabelForScore(45)).toBe('Bronze Parent');
    expect(parentTrustLabelForScore(10)).toBe('Suspended');
    expect(parentTrustLabelForScore(99, true)).toBe('Suspended');
  });
});

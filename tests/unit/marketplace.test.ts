import { describe, expect, it } from 'vitest';
import {
  audDollarsToCents,
  formatAudCents,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CATEGORY_FILTERS,
  MARKETPLACE_CONDITIONS,
  MARKETPLACE_HOUSEHOLD_ENV,
  MARKETPLACE_SIZE_AGE_OPTIONS,
  MARKETPLACE_TRADE_FILTERS,
  offerLabelForTrade,
  tradeBadgeLabel,
  tradeTypeToListingKind,
} from '../../shared/marketplace';

describe('marketplace trade and category helpers', () => {
  it('exposes full kids spectrum categories and trade filters', () => {
    expect(MARKETPLACE_CATEGORIES).toEqual([
      'Baby & Toddler Gear',
      'Toys & Outdoor',
      'Kids Fashion & Shoes',
      'Books & Learning',
      'School & Nursery',
    ]);
    expect(MARKETPLACE_CATEGORY_FILTERS.map((entry) => entry.id)).toEqual([
      'all',
      ...MARKETPLACE_CATEGORIES,
    ]);
    expect(MARKETPLACE_TRADE_FILTERS.map((entry) => entry.label)).toEqual([
      'All',
      'Sell',
      'Free Share (Relay)',
      'Swap / Barter',
    ]);
  });

  it('maps trade types and formats AUD asks for Sell cards', () => {
    expect(tradeTypeToListingKind('sale')).toBe('sale');
    expect(tradeTypeToListingKind('free_share')).toBe('giveaway');
    expect(tradeTypeToListingKind('swap')).toBe('swap');
    expect(offerLabelForTrade('sale')).toBe('SALE');
    expect(tradeBadgeLabel('SALE', 'sale')).toBe('SALE');
    expect(audDollarsToCents('50')).toBe(5000);
    expect(audDollarsToCents('$12.50')).toBe(1250);
    expect(formatAudCents(5000)).toBe('$50 AUD');
    expect(formatAudCents(1250)).toBe('$12.50 AUD');
  });

  it('exposes smart feature chip options for condition size and household environment', () => {
    expect(MARKETPLACE_CONDITIONS).toEqual(['New', 'Like New', 'Good']);
    expect(MARKETPLACE_HOUSEHOLD_ENV).toEqual(['Smoke-free', 'Pet-free']);
    expect(MARKETPLACE_SIZE_AGE_OPTIONS).toContain('Size 8');
    expect(MARKETPLACE_SIZE_AGE_OPTIONS).toContain('0–6 months');
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildCreateItemListingArgs,
  friendlyListingContactError,
  friendlyListingCreateError,
  isOwnListing,
} from '../../shared/listing-create';

describe('listing create payload', () => {
  it('aligns trade ask images and optional specs with create_item_listing args', () => {
    const args = buildCreateItemListingArgs({
      kind: 'sale',
      title: 'Size 8 sports shorts',
      description: 'Gently used school sports shorts.',
      category: 'Kids Fashion & Shoes',
      offerLabel: 'SALE',
      askAudCents: 4500,
      listingImages: [
        { src: `data:image/jpeg;base64,${'a'.repeat(40)}`, cover: false },
        { src: `data:image/jpeg;base64,${'b'.repeat(40)}`, cover: true },
      ],
      itemCondition: 'Like New',
      sizeAgeLabel: 'Size 8',
      householdEnv: ['Smoke-free', 'Pet-free'],
    });

    expect(args.p_listing_kind).toBe('sale');
    expect(args.p_ask_aud_cents).toBe(4500);
    expect(args.p_item_condition).toBe('Like New');
    expect(args.p_size_age_label).toBe('Size 8');
    expect(args.p_household_env).toEqual(['Smoke-free', 'Pet-free']);
    expect(args.p_listing_images).toEqual([
      { src: `data:image/jpeg;base64,${'a'.repeat(40)}`, cover: false },
      { src: `data:image/jpeg;base64,${'b'.repeat(40)}`, cover: true },
    ]);
  });

  it('falls back optional fields to null or empty arrays', () => {
    const args = buildCreateItemListingArgs({
      kind: 'giveaway',
      title: 'Spare reader book',
      description: 'Free to a family at our school.',
      category: 'Books & Learning',
      offerLabel: 'FREE',
    });
    expect(args.p_ask_aud_cents).toBeNull();
    expect(args.p_listing_images).toEqual([]);
    expect(args.p_item_condition).toBeNull();
    expect(args.p_size_age_label).toBeNull();
    expect(args.p_household_env).toEqual([]);
  });

  it('maps RPC failures to clear parent-facing messages', () => {
    expect(friendlyListingCreateError('sale listings need an AUD ask')).toMatch(/AUD ask/i);
    expect(friendlyListingCreateError('listing images must be up to six')).toMatch(/images/i);
    expect(friendlyListingCreateError('Could not find the function public.create_item_listing')).toMatch(/db:migrate/i);
  });

  it('blocks own-listing contact and maps self-chat/enquire 400s', () => {
    expect(isOwnListing('user-a', 'user-a')).toBe(true);
    expect(isOwnListing('user-a', 'user-b')).toBe(false);
    expect(friendlyListingContactError('authors cannot enquire on their own listing', 'enquire'))
      .toBe('This is your own listing.');
    expect(friendlyListingContactError('authors cannot open marketplace chat with themselves', 'chat'))
      .toBe('This is your own listing.');
  });
});

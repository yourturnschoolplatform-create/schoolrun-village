import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildCreateItemListingArgs,
  friendlyListingContactError,
  friendlyListingCreateError,
  type CreateListingInput,
} from '../../shared/listing-create';
import type { MarketplaceScope } from '../../shared/marketplace-neighbourhood';
import type {
  ListingImagePayload,
  MarketplaceCondition,
  MarketplaceHouseholdEnv,
  MarketplaceListingKind,
  MarketplaceTradeType,
} from '../../shared/marketplace';
import { withListingChatSummary, type ChatRoom } from './chat-api';

export type ItemListing = {
  id: string;
  school_id: string;
  author_id: string;
  author_display_name: string;
  listing_kind: MarketplaceListingKind;
  title: string;
  description: string;
  category: string;
  display_offer_label: string;
  status: string;
  created_at: string;
  schoolDisplayName?: string;
  schoolSuburb?: string;
  schoolSector?: 'primary' | 'secondary';
  areaLabel?: string;
  sameSchool?: boolean;
  distanceKm?: number | null;
  authorTrustBand?: string;
  authorParentTrustBand?: string;
  askAudCents?: number | null;
  askAudDisplay?: string | null;
  listingImages?: ListingImagePayload[] | null;
  itemCondition?: MarketplaceCondition | null;
  sizeAgeLabel?: string | null;
  householdEnv?: MarketplaceHouseholdEnv[] | null;
  favoriteCount?: number;
  viewerHasFavorited?: boolean;
};

export type ListingFavoriteToggle = {
  listingId: string;
  favorited: boolean;
  favoriteCount: number;
};

async function rpc<T>(client: SupabaseClient, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    const detail = [error.message, error.details, error.hint].filter(Boolean).join(' — ');
    throw new Error(detail || 'That marketplace action is not available right now.');
  }
  return data as T;
}

function isMissingArgError(error: unknown): boolean {
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return text.includes('pgrst202')
    || text.includes('could not find the function')
    || text.includes('unexpected')
    || text.includes('p_area_label')
    || text.includes('p_scope')
    || text.includes('p_area_labels');
}

export const listingsApi = {
  search: async (
    client: SupabaseClient,
    input: {
      query?: string | null;
      kind?: MarketplaceListingKind | MarketplaceTradeType | null;
      category?: string | null;
      scope?: MarketplaceScope | null;
      areaLabels?: string[] | null;
    } = {},
  ) => {
    const base = {
      p_query: input.query ?? null,
      p_listing_kind: input.kind ?? null,
      p_category: input.category ?? null,
    };
    try {
      return await rpc<ItemListing[]>(client, 'search_item_listings', {
        ...base,
        p_scope: input.scope ?? 'nearby',
        p_area_labels: input.areaLabels?.length ? input.areaLabels : null,
      });
    } catch (error) {
      if (!isMissingArgError(error)) throw error;
      // Pre-0073 schema: school-scoped search only.
      return rpc<ItemListing[]>(client, 'search_item_listings', base);
    }
  },
  create: async (client: SupabaseClient, input: CreateListingInput) => {
    const args = buildCreateItemListingArgs(input);
    try {
      return await rpc<ItemListing>(client, 'create_item_listing', args);
    } catch (error) {
      if (isMissingArgError(error) && 'p_area_label' in args) {
        const { p_area_label: _ignored, ...legacy } = args;
        try {
          return await rpc<ItemListing>(client, 'create_item_listing', legacy);
        } catch (legacyError) {
          throw new Error(
            friendlyListingCreateError(
              legacyError instanceof Error ? legacyError.message : String(legacyError),
            ),
          );
        }
      }
      throw new Error(friendlyListingCreateError(error instanceof Error ? error.message : String(error)));
    }
  },
  /**
   * create_listing_enquiry(p_listing_id, p_body) — buyer/seller derived from auth.uid()
   * and listing.author_id server-side. No seller_id/buyer_id args.
   */
  enquire: async (client: SupabaseClient, listingId: string, body: string) => {
    try {
      return await rpc(client, 'create_listing_enquiry', {
        p_listing_id: listingId,
        p_body: body,
      });
    } catch (error) {
      throw new Error(friendlyListingContactError(
        error instanceof Error ? error.message : String(error),
        'enquire',
      ));
    }
  },
  /**
   * get_or_create_listing_chat(p_listing_id) — peer ids derived from auth.uid()
   * and listing.author_id. Authors cannot open chat with themselves.
   */
  openListingChat: async (
    client: SupabaseClient,
    listingId: string,
    listingSummary?: Pick<
      ItemListing,
      'id' | 'title' | 'author_id' | 'askAudCents' | 'askAudDisplay' | 'display_offer_label' | 'listingImages'
    >,
  ) => {
    try {
      const room = await rpc<ChatRoom>(client, 'get_or_create_listing_chat', {
        p_listing_id: listingId,
      });
      return listingSummary
        ? withListingChatSummary(room, listingSummary)
        : room;
    } catch (error) {
      throw new Error(friendlyListingContactError(
        error instanceof Error ? error.message : String(error),
        'chat',
      ));
    }
  },
  /**
   * toggle_listing_favorite(p_listing_id) — inserts or deletes listing_favorites
   * for auth.uid(). Authors cannot favourite their own listing.
   */
  toggleFavorite: async (client: SupabaseClient, listingId: string) => {
    try {
      const result = await rpc<ListingFavoriteToggle>(client, 'toggle_listing_favorite', {
        p_listing_id: listingId,
      });
      return {
        listingId: result.listingId ?? listingId,
        favorited: Boolean(result.favorited),
        favoriteCount: Number(result.favoriteCount ?? 0),
      } satisfies ListingFavoriteToggle;
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? error.message
          : 'That favourite could not be updated right now.',
      );
    }
  },
};

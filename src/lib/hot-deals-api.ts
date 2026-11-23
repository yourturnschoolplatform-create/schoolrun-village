import type { SupabaseClient } from '@supabase/supabase-js';
import {
  HOT_DEALS_CATALOGUE,
  normalizeHotDeal,
  type HotDeal,
  type HotDealUpsertInput,
} from '../../shared/hot-deals';

const SAVE_LOCAL_KEY = 'yourturn.hot-deal-saves';

function readLocalJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeLocalJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota */
  }
}

function readLocalSavedIds(): string[] {
  if (typeof window === 'undefined') return [];
  const raw = readLocalJson<unknown[]>(SAVE_LOCAL_KEY, []);
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
}

function friendlyRpcError(error: unknown, fallback: string): Error {
  const text = error instanceof Error ? error.message : String(error ?? '');
  const lower = text.toLowerCase();
  if (lower.includes('42501') || lower.includes('administrator') || lower.includes('permission') || lower.includes('not authorized')) {
    return new Error('Administrator access is required to manage Hot Deals.');
  }
  if (lower.includes('authentication required') || lower.includes('jwt') || lower.includes('not authenticated')) {
    return new Error('Sign in again to manage Hot Deals.');
  }
  if (lower.includes('pgrst202') || lower.includes('could not find the function') || lower.includes('does not exist')) {
    return new Error('Hot Deals admin is not available on the database yet. Confirm migration 0087 is applied.');
  }
  return new Error(fallback);
}

/** Parent feed: remote active deals, with catalogue seed only when the list RPC is unavailable. */
function mergeParentFeed(remote: HotDeal[]): HotDeal[] {
  const saved = new Set(readLocalSavedIds());
  const byId = new Map<string, HotDeal>();
  for (const deal of HOT_DEALS_CATALOGUE) byId.set(deal.id, normalizeHotDeal(deal));
  for (const deal of remote) byId.set(deal.id, normalizeHotDeal(deal));
  return [...byId.values()]
    .filter((deal) => (deal.status ?? 'active') === 'active')
    .map((deal) => ({
      ...deal,
      viewerHasSaved: Boolean(deal.viewerHasSaved) || saved.has(deal.id),
    }));
}

async function rpcJson<T>(client: SupabaseClient, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data as T;
}

export const hotDealsApi = {
  /** Parent-facing active Hot Deals. Never writes admin content to localStorage. */
  list: async (client: SupabaseClient | null): Promise<HotDeal[]> => {
    if (!client) return mergeParentFeed([]);
    try {
      const data = await rpcJson<HotDeal[]>(client, 'list_hot_deals');
      const list = Array.isArray(data) ? data.map((entry) => normalizeHotDeal(entry)) : [];
      return mergeParentFeed(list);
    } catch {
      // Read-only fallback for parents when RPC is briefly unavailable.
      return mergeParentFeed([]);
    }
  },

  /**
   * Admin list from Supabase only.
   * Failures raise a clear English error — no localStorage admin catalogue.
   */
  adminList: async (client: SupabaseClient): Promise<HotDeal[]> => {
    try {
      const data = await rpcJson<HotDeal[]>(client, 'admin_list_hot_deals');
      if (!Array.isArray(data)) {
        throw new Error('Hot Deals admin list returned an unexpected response.');
      }
      return data.map((entry) => normalizeHotDeal(entry));
    } catch (error) {
      throw friendlyRpcError(
        error,
        'Hot Deals could not be loaded for admin. Check your admin role and try again.',
      );
    }
  },

  /**
   * Admin upsert to Supabase only.
   * Failures raise a clear English error — never silently persist to localStorage.
   */
  upsert: async (client: SupabaseClient, input: HotDealUpsertInput): Promise<HotDeal> => {
    const payload = {
      id: input.id || null,
      brandName: input.brandName.trim(),
      brandMark: input.brandMark.trim().slice(0, 4) || 'SR',
      title: input.title.trim(),
      summary: input.summary.trim(),
      description: input.description.trim(),
      category: input.category.trim(),
      originalAskAudCents: input.originalAskAudCents,
      groupAskAudCents: input.groupAskAudCents,
      joinedCount: input.joinedCount,
      targetCount: input.targetCount,
      bonusDiscountAudCents: input.bonusDiscountAudCents,
      ctaLabel: input.ctaLabel,
      dealImages: input.dealImages,
      videoUrl: input.videoUrl,
      status: input.status ?? 'active',
    };
    try {
      const saved = await rpcJson<HotDeal>(client, 'admin_upsert_hot_deal', { p_payload: payload });
      return normalizeHotDeal(saved);
    } catch (error) {
      throw friendlyRpcError(
        error,
        'That Hot Deal could not be saved. Confirm you are signed in as an admin and try again.',
      );
    }
  },

  /** Parent Save toggle. Prefers DB; localStorage is only a personal fallback for Save state. */
  toggleSave: async (client: SupabaseClient | null, dealId: string): Promise<{ dealId: string; saved: boolean }> => {
    if (client) {
      try {
        const result = await rpcJson<{ dealId: string; saved: boolean }>(client, 'toggle_hot_deal_save', {
          p_deal_id: dealId,
        });
        return {
          dealId: result.dealId || dealId,
          saved: Boolean(result.saved),
        };
      } catch {
        /* fall through to personal save fallback */
      }
    }
    const current = new Set(readLocalSavedIds());
    const saved = !current.has(dealId);
    if (saved) current.add(dealId);
    else current.delete(dealId);
    writeLocalJson(SAVE_LOCAL_KEY, [...current]);
    return { dealId, saved };
  },
};

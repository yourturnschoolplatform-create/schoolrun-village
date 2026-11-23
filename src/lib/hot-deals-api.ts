import type { SupabaseClient } from '@supabase/supabase-js';
import {
  HOT_DEALS_CATALOGUE,
  normalizeHotDeal,
  type HotDeal,
  type HotDealUpsertInput,
} from '../../shared/hot-deals';

const ADMIN_LOCAL_KEY = 'yourturn.hot-deals.admin';
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

function readLocalAdminDeals(): HotDeal[] {
  if (typeof window === 'undefined') return [];
  const raw = readLocalJson<unknown[]>(ADMIN_LOCAL_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => normalizeHotDeal({
      id: String(entry.id ?? `deal-local-${Date.now()}`),
      title: String(entry.title ?? 'Hot Deal'),
      ...(entry as Partial<HotDeal>),
    }));
}

function readLocalSavedIds(): string[] {
  if (typeof window === 'undefined') return [];
  const raw = readLocalJson<unknown[]>(SAVE_LOCAL_KEY, []);
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
}

function mergeCatalogue(remote: HotDeal[]): HotDeal[] {
  const local = readLocalAdminDeals();
  const saved = new Set(readLocalSavedIds());
  const byId = new Map<string, HotDeal>();
  for (const deal of HOT_DEALS_CATALOGUE) byId.set(deal.id, normalizeHotDeal(deal));
  for (const deal of remote) byId.set(deal.id, normalizeHotDeal(deal));
  for (const deal of local) byId.set(deal.id, normalizeHotDeal(deal));
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
  list: async (client: SupabaseClient | null): Promise<HotDeal[]> => {
    if (!client) return mergeCatalogue([]);
    try {
      const data = await rpcJson<HotDeal[]>(client, 'list_hot_deals');
      const list = Array.isArray(data) ? data.map((entry) => normalizeHotDeal(entry)) : [];
      return mergeCatalogue(list);
    } catch {
      return mergeCatalogue([]);
    }
  },

  adminList: async (client: SupabaseClient): Promise<HotDeal[]> => {
    try {
      const data = await rpcJson<HotDeal[]>(client, 'admin_list_hot_deals');
      const list = Array.isArray(data) ? data.map((entry) => normalizeHotDeal(entry)) : [];
      const local = readLocalAdminDeals();
      const byId = new Map<string, HotDeal>();
      for (const deal of HOT_DEALS_CATALOGUE) byId.set(deal.id, normalizeHotDeal(deal));
      for (const deal of list) byId.set(deal.id, deal);
      for (const deal of local) byId.set(deal.id, deal);
      return [...byId.values()];
    } catch {
      return mergeCatalogue([]).concat(readLocalAdminDeals().filter((deal) => deal.status !== 'active'));
    }
  },

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
    } catch {
      const local = normalizeHotDeal({
        ...payload,
        id: payload.id || `deal-local-${Date.now().toString(36)}`,
      });
      const existing = readLocalAdminDeals().filter((deal) => deal.id !== local.id);
      writeLocalJson(ADMIN_LOCAL_KEY, [...existing, local]);
      return local;
    }
  },

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
        /* fall through to local */
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

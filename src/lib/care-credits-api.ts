import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_CARE_WALLET,
  normalizeCareWallet,
  type CareCreditWallet,
} from '../../shared/care-credits';

export type CareCreditSettlement = {
  requestId?: string;
  earnedCareCredit?: number;
  callerIsProvider?: boolean;
  usedSosPass?: boolean;
  providerWallet?: CareCreditWallet;
  receiverWallet?: CareCreditWallet;
  error?: string;
};

function friendlyError(error: unknown, fallback: string): Error {
  const text = error instanceof Error ? error.message : String(error ?? '');
  const lower = text.toLowerCase();
  if (lower.includes('authentication')) return new Error('Sign in again to refresh Care Credits.');
  if (lower.includes('pgrst202') || lower.includes('could not find the function')) {
    return new Error('Care Credits are not available on the database yet. Confirm migration 0088 is applied.');
  }
  return new Error(fallback);
}

export const careCreditsApi = {
  getWallet: async (client: SupabaseClient): Promise<CareCreditWallet> => {
    try {
      const { data, error } = await client.rpc('get_care_credit_wallet');
      if (error) throw error;
      return normalizeCareWallet(data as Partial<CareCreditWallet>);
    } catch (error) {
      // Read fallback keeps UI usable before/without migration; never invent admin writes.
      if (typeof console !== 'undefined') {
        console.warn('get_care_credit_wallet', error);
      }
      return DEFAULT_CARE_WALLET;
    }
  },

  settleInstantPickup: async (
    client: SupabaseClient,
    requestId: string,
  ): Promise<CareCreditSettlement> => {
    try {
      const { data, error } = await client.rpc('settle_instant_pickup_care_credits', {
        p_request_id: requestId,
      });
      if (error) throw error;
      const row = (data ?? {}) as CareCreditSettlement;
      return {
        ...row,
        providerWallet: row.providerWallet
          ? normalizeCareWallet(row.providerWallet)
          : undefined,
        receiverWallet: row.receiverWallet
          ? normalizeCareWallet(row.receiverWallet)
          : undefined,
      };
    } catch (error) {
      throw friendlyError(error, 'Care Credits could not be settled for this Instant Pickup.');
    }
  },
};

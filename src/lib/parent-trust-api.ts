import type { SupabaseClient } from '@supabase/supabase-js';
import type { ParentTrustProfile } from '../../shared/parent-trust';
import { parentTrustLabelForBand } from '../../shared/parent-trust';

async function rpc<T>(client: SupabaseClient, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error('That parent trust profile is not available right now.');
  return data as T;
}

export const parentTrustApi = {
  getPeerProfile: async (client: SupabaseClient, peerUserId: string): Promise<ParentTrustProfile> => {
    const row = await rpc<{
      peerUserId: string;
      displayName: string;
      trustBand: string;
      parentTrustBand: string;
      schoolSuburb: string;
      verifiedSchool: boolean;
      successfulPickups: number;
      communityRelayShares: number;
    }>(client, 'get_peer_parent_trust_profile', { p_peer_user_id: peerUserId });
    return {
      peerUserId: row.peerUserId,
      displayName: row.displayName,
      trustBand: row.trustBand,
      parentTrustBand: parentTrustLabelForBand(row.parentTrustBand || row.trustBand),
      schoolSuburb: row.schoolSuburb,
      verifiedSchool: Boolean(row.verifiedSchool),
      successfulPickups: Number(row.successfulPickups) || 0,
      communityRelayShares: Number(row.communityRelayShares) || 0,
    };
  },
};

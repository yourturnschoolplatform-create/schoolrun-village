import type { SupabaseClient } from '@supabase/supabase-js';

export type MatchCandidate = { viewer_need_instance_id: string; candidate_help_instance_id: string; candidate_need_instance_id: string; viewer_help_instance_id: string; candidate_id: string; candidate_name: string; trust_band: 'Trusted' | 'Standard' | 'Caution' | 'Restricted' | 'Suspended'; area_label: string; first_date: string; reciprocal_date: string; time_overlap_minutes: number; reciprocal_overlap_minutes: number; same_area: boolean };
export type Swap = { id: string; status: 'proposed' | 'accepted' | 'declined' | 'withdrawn' | 'expired' | 'cancelled_consent_revoked'; isIncoming: boolean; partnerName: string; expiresAt: string; acceptedAt: string | null; schoolId: string };
async function token(client: SupabaseClient) { const { data } = await client.auth.getSession(); if (!data.session?.access_token) throw new Error('Please sign in again to use matching.'); return data.session.access_token; }
async function request<T>(client: SupabaseClient, path: string, init: RequestInit = {}) { const response = await fetch(`/api/matches${path}`, { ...init, cache: 'no-store', headers: { Accept: 'application/json', Authorization: `Bearer ${await token(client)}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } }); if (!response.ok) throw new Error('That match action is no longer available.'); return response.json() as Promise<T>; }
export const matchApi = {
  candidates: (client: SupabaseClient, differentDates: boolean) => request<{ candidates: MatchCandidate[] }>(client, `/candidates?differentDates=${differentDates}`),
  swaps: (client: SupabaseClient) => request<{ swaps: Swap[] }>(client, '/swaps'),
  propose: (client: SupabaseClient, c: MatchCandidate) => request<{ swapId: string }> (client, '/proposals', { method: 'POST', body: JSON.stringify({ viewerNeedInstanceId: c.viewer_need_instance_id, candidateHelpInstanceId: c.candidate_help_instance_id, candidateNeedInstanceId: c.candidate_need_instance_id, viewerHelpInstanceId: c.viewer_help_instance_id, allowDifferentDate: c.first_date !== c.reciprocal_date }) }),
  action: (client: SupabaseClient, swapId: string, action: 'accept' | 'decline' | 'withdraw') => request<{ status: string }>(client, `/swaps/${swapId}/${action}`, { method: 'POST' }),
  block: (client: SupabaseClient, candidateId: string) => request<{ status: string }>(client, '/blocks', { method: 'POST', body: JSON.stringify({ candidateId }) }),
  children: (client: SupabaseClient, swapId: string) => request<{ children: Array<{ nickname: string; yearLevel: number }> }>(client, `/swaps/${swapId}/children`),
};

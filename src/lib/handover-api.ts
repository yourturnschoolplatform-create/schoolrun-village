import type { SupabaseClient } from '@supabase/supabase-js';

export type HandoverConfirmationKind = 'pickup_done' | 'child_arrived';

export type HandoverLeg = {
  id: string;
  serviceDate: string;
  expectedArrivalAt: string | null;
  completedAt: string | null;
  isProvider: boolean;
  isRecipient: boolean;
  confirmations: {
    kind: HandoverConfirmationKind;
    confirmedAt: string;
  }[];
  reminder: {
    missingConfirmation: HandoverConfirmationKind;
    dueAt: string;
    createdAt: string;
    resolved: boolean;
  } | null;
};

export type HandoverResponse = {
  timeZone: string;
  legs: HandoverLeg[];
};

export type HandoverConfirmationResponse = {
  confirmation: {
    legId: string;
    confirmationKind: HandoverConfirmationKind;
    confirmedAt: string;
    completedAt: string | null;
  };
};

async function request<T>(client: SupabaseClient, path: string, method: 'GET' | 'POST'): Promise<T> {
  try {
    const { data, error } = await client.auth.getSession();
    if (error || !data.session?.access_token) throw new Error('Unauthenticated');
    const response = await fetch(`/api/handover${path}`, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${data.session.access_token}`,
      },
    });
    if (!response.ok) throw new Error('Handover request failed');
    return await response.json() as T;
  } catch {
    // Authentication, permission and server errors never disclose response bodies.
    throw new Error('That handover action could not be completed. Please try again.');
  }
}

export function getHandover(client: SupabaseClient, swapId: string): Promise<HandoverResponse> {
  return request(client, `/swaps/${encodeURIComponent(swapId)}`, 'GET');
}

export function confirmHandover(
  client: SupabaseClient,
  legId: string,
  kind: HandoverConfirmationKind,
): Promise<HandoverConfirmationResponse> {
  if (kind !== 'pickup_done' && kind !== 'child_arrived') {
    return Promise.reject(new Error('That handover action could not be completed. Please try again.'));
  }
  const action = kind === 'pickup_done' ? 'pickup' : 'arrival';
  return request(client, `/legs/${encodeURIComponent(legId)}/${action}`, 'POST');
}

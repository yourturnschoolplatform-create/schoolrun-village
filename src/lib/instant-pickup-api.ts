import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { SchoolRunDirection, ScheduleIntent } from '../../shared/schedules';
import type { ChatRoom } from './chat-api';

export type InstantPickupCheckInStatus = 'pending' | 'confirmed' | null;

export type InstantPickupRequest = {
  id: string;
  schoolId: string;
  requesterId: string;
  requesterDisplayName: string;
  matchedUserId: string | null;
  matchedDisplayName: string | null;
  intent: ScheduleIntent;
  direction: SchoolRunDirection;
  targetDate: string;
  areaLabel: string;
  notes: string | null;
  status: 'open' | 'matched' | 'expired' | 'cancelled';
  checkInStatus: InstantPickupCheckInStatus;
  finalCheckAt: string | null;
  pickupAt: string | null;
  chatRoomId: string | null;
  mine: boolean;
  iAmMatched: boolean;
  createdAt: string;
  schoolSuburb?: string;
  requesterTrustBand?: string;
  requesterParentTrustBand?: string;
};

export type InstantPickupAcceptResult = {
  request: InstantPickupRequest;
  chatRoom: ChatRoom;
};

async function rpc<T>(client: SupabaseClient, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error('That instant pickup action is not available right now.');
  return data as T;
}

export const instantPickupApi = {
  list: (client: SupabaseClient, includeClosed = false) =>
    rpc<InstantPickupRequest[]>(client, 'list_instant_pickup_requests', {
      p_include_closed: includeClosed,
    }),
  create: (
    client: SupabaseClient,
    input: {
      intent: ScheduleIntent;
      direction: SchoolRunDirection;
      areaLabel: string;
      targetDate?: string | null;
      notes?: string | null;
    },
  ) => rpc<InstantPickupRequest>(client, 'create_instant_pickup_request', {
    p_intent: input.intent,
    p_direction: input.direction,
    p_area_label: input.areaLabel,
    p_target_date: input.targetDate ?? null,
    p_notes: input.notes ?? null,
  }),
  cancel: (client: SupabaseClient, requestId: string) =>
    rpc<InstantPickupRequest>(client, 'cancel_instant_pickup_request', {
      p_request_id: requestId,
    }),
  accept: (client: SupabaseClient, requestId: string) =>
    rpc<InstantPickupAcceptResult>(client, 'accept_instant_pickup_request', {
      p_request_id: requestId,
    }),
  checkIn: (client: SupabaseClient, requestId: string, confirm: boolean) =>
    rpc<InstantPickupRequest>(client, 'check_in_instant_pickup', {
      p_request_id: requestId,
      p_confirm: confirm,
    }),
  openChat: (client: SupabaseClient, requestId: string) =>
    rpc<ChatRoom>(client, 'get_instant_pickup_chat', {
      p_request_id: requestId,
    }),
  subscribe: (
    client: SupabaseClient,
    schoolId: string,
    onChange: () => void,
  ): RealtimeChannel => {
    const channel = client
      .channel(`instant-pickup:${schoolId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'instant_pickup_requests',
          filter: `school_id=eq.${schoolId}`,
        },
        () => { onChange(); },
      )
      .subscribe();
    return channel;
  },
};

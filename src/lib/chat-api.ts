import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

export type ChatSchedulePin = {
  patternId: string;
  weekday: number;
  weekdayLabel: string;
  windowStart: string;
  windowEnd: string;
  areaLabel: string;
  direction: string;
  intent: string;
  pinKind?: 'schedule' | 'instant_pickup' | 'marketplace';
  /** Marketplace listing pin (get_or_create_listing_chat / chat_listing_pin_json). */
  listingId?: string;
  listingTitle?: string;
  askAudCents?: number | null;
  askAudDisplay?: string | null;
  offerLabel?: string | null;
  coverSrc?: string | null;
  sellerId?: string;
};

export type ChatRoom = {
  id: string;
  schoolId: string;
  peerUserId: string;
  peerDisplayName: string;
  schedule: ChatSchedulePin;
  lastMessageBody: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  createdAt: string;
};

/** Attach listing card summary onto a marketplace chat room (client-side enrich). */
export function withListingChatSummary(
  room: ChatRoom,
  listing: {
    id: string;
    title: string;
    author_id: string;
    askAudCents?: number | null;
    askAudDisplay?: string | null;
    display_offer_label?: string;
    listingImages?: Array<{ src: string; cover?: boolean }> | null;
  },
): ChatRoom {
  const cover = listing.listingImages?.find((entry) => entry.cover)?.src
    ?? listing.listingImages?.[0]?.src
    ?? null;
  const ask = listing.askAudDisplay
    ?? (listing.askAudCents && listing.askAudCents > 0
      ? `$${(listing.askAudCents / 100).toFixed(listing.askAudCents % 100 === 0 ? 0 : 2)} AUD`
      : null);
  const offer = (listing.display_offer_label || '').trim().toUpperCase();
  const askAudDisplay = ask
    ?? (offer === 'SWAP' ? 'Swap' : offer === 'SALE' ? 'Sale' : 'Free Share');

  return {
    ...room,
    schedule: {
      ...room.schedule,
      pinKind: 'marketplace',
      patternId: listing.id,
      weekdayLabel: listing.title.slice(0, 80),
      listingId: listing.id,
      listingTitle: listing.title.slice(0, 120),
      askAudCents: listing.askAudCents ?? null,
      askAudDisplay,
      offerLabel: listing.display_offer_label ?? room.schedule.offerLabel ?? null,
      coverSrc: cover ?? room.schedule.coverSrc ?? null,
      sellerId: listing.author_id,
    },
  };
}

export type ChatMessage = {
  id: string;
  roomId: string;
  senderId: string;
  body: string;
  createdAt: string;
  mine: boolean;
  readByPeer: boolean;
};

async function rpc<T>(client: SupabaseClient, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error('That chat action is not available right now.');
  return data as T;
}

export const chatApi = {
  listRooms: (client: SupabaseClient) => rpc<ChatRoom[]>(client, 'list_my_chat_rooms'),
  openScheduleChat: (client: SupabaseClient, peerUserId: string, availabilityPatternId: string) =>
    rpc<ChatRoom>(client, 'get_or_create_schedule_chat', {
      p_peer_user_id: peerUserId,
      p_availability_pattern_id: availabilityPatternId,
    }),
  openSwapChat: (client: SupabaseClient, swapId: string) =>
    rpc<ChatRoom>(client, 'get_or_create_swap_chat', { p_swap_id: swapId }),
  openListingChat: (client: SupabaseClient, listingId: string) =>
    rpc<ChatRoom>(client, 'get_or_create_listing_chat', { p_listing_id: listingId }),
  listMessages: (client: SupabaseClient, roomId: string, before?: string | null) =>
    rpc<ChatMessage[]>(client, 'list_chat_messages', {
      p_room_id: roomId,
      p_before: before ?? null,
      p_limit: 50,
    }),
  send: (client: SupabaseClient, roomId: string, body: string) =>
    rpc<ChatMessage>(client, 'send_chat_message', { p_room_id: roomId, p_body: body }),
  markRead: (client: SupabaseClient, roomId: string) =>
    rpc<{ roomId: string; lastReadAt: string }>(client, 'mark_chat_room_read', { p_room_id: roomId }),
  /**
   * Subscribe to new rows in a room. Relies on RLS + supabase_realtime publication.
   * Caller must unsubscribe the returned channel.
   */
  subscribeMessages: (
    client: SupabaseClient,
    roomId: string,
    onInsert: (row: { id: string; room_id: string; sender_id: string; body: string; created_at: string }) => void,
  ): RealtimeChannel => {
    const channel = client
      .channel(`chat-room:${roomId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_messages',
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          const row = payload.new as {
            id: string; room_id: string; sender_id: string; body: string; created_at: string;
          };
          onInsert(row);
        },
      )
      .subscribe();
    return channel;
  },
};

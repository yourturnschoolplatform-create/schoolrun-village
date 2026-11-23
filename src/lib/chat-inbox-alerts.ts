import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { chatApi, type ChatRoom } from './chat-api';

export type InboxToast = {
  id: string;
  title: string;
  body: string;
  roomId: string | null;
  kind: 'chat' | 'match';
  /** Marketplace item / Instant Pickup / suburb context line. */
  context: string | null;
};

export type ChatInboxAlertHandlers = {
  onUnreadTotal: (total: number) => void;
  onToast: (toast: InboxToast) => void;
  /** Room currently open in any 1:1 surface (Messages, listing overlay, match drawer). */
  getActiveRoomId: () => string | null;
};

function baseAppTitle(): string {
  if (typeof document === 'undefined') return 'SchoolRun Village';
  const current = document.title.replace(/^\(\d+\)\s+/, '').trim();
  return current || 'SchoolRun Village';
}

export function applyUnreadDocumentTitle(unread: number): void {
  if (typeof document === 'undefined') return;
  const base = baseAppTitle();
  if (typeof document.hidden === 'boolean' && document.hidden && unread > 0) {
    document.title = `(${unread}) ${base}`;
  } else {
    document.title = base;
  }
}

function sanitizePreview(raw: string | undefined): string {
  const text = (raw || '').trim();
  if (!text) return 'New message';
  if (/^HOUSEHOLD_CONFIRM_CODE::/i.test(text)) return 'Shared a one-time match code';
  return text.slice(0, 80).replace(/\+?\d[\d\s()-]{7,}\d/g, '•••');
}

export function roomContextLabel(room: ChatRoom | undefined | null): string | null {
  if (!room?.schedule) return null;
  const schedule = room.schedule;
  if (schedule.pinKind === 'marketplace') {
    const title = (schedule.listingTitle || schedule.weekdayLabel || '').trim();
    const ask = (schedule.askAudDisplay || '').trim();
    if (title && ask) return `${title} · ${ask}`;
    if (title) return title;
    return 'Marketplace';
  }
  if (schedule.pinKind === 'instant_pickup') {
    const area = (schedule.areaLabel || '').trim();
    return area ? `Instant Pickup · ${area}` : 'Instant Pickup';
  }
  if (schedule.pinKind === 'discussion') {
    const title = (schedule.threadTitle || schedule.weekdayLabel || '').trim();
    return title || 'School thread';
  }
  const area = (schedule.areaLabel || '').trim();
  const day = (schedule.weekdayLabel || '').trim();
  if (day && area) return `${day} · ${area}`;
  return area || day || null;
}

/**
 * Live inbox: unread badge total + Karrot-style top banner for messages / matches
 * when the parent is not already viewing that exact thread.
 * Never toasts the sender's own inserts (filtered by sender_id === userId).
 */
export function subscribeChatInboxAlerts(
  client: SupabaseClient,
  userId: string,
  handlers: ChatInboxAlertHandlers,
): () => void {
  let rooms: ChatRoom[] = [];
  let disposed = false;
  const channels: RealtimeChannel[] = [];

  const refreshUnread = async () => {
    try {
      rooms = await chatApi.listRooms(client);
      if (disposed) return;
      const total = rooms.reduce((sum, room) => sum + (room.unreadCount || 0), 0);
      handlers.onUnreadTotal(total);
      applyUnreadDocumentTitle(total);
    } catch {
      /* keep last known */
    }
  };

  void refreshUnread();

  const messageChannel = client
    .channel(`chat-inbox-messages:${userId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'chat_messages' },
      (payload) => {
        const row = payload.new as {
          id?: string;
          room_id?: string;
          sender_id?: string;
          body?: string;
        };
        // Never notify the sender about their own message.
        if (!row?.room_id || !row.sender_id || row.sender_id === userId) return;

        void (async () => {
          await refreshUnread();
          if (disposed) return;
          // Suppress banner only for the currently open 1:1 room.
          if (handlers.getActiveRoomId() === row.room_id) return;

          const room = rooms.find((entry) => entry.id === row.room_id);
          const peer = room?.peerDisplayName?.trim() || 'Parent';
          const context = roomContextLabel(room);
          handlers.onToast({
            id: row.id || `${row.room_id}-${Date.now()}`,
            title: peer,
            body: sanitizePreview(row.body),
            roomId: row.room_id,
            kind: 'chat',
            context,
          });
        })();
      },
    )
    .subscribe();
  channels.push(messageChannel);

  const matchChannel = client
    .channel(`chat-inbox-matches:${userId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'instant_pickup_requests' },
      (payload) => {
        const row = payload.new as {
          id?: string;
          status?: string;
          requester_id?: string;
          matched_user_id?: string | null;
          chat_room_id?: string | null;
          area_label?: string | null;
        };
        const old = payload.old as { status?: string } | undefined;
        if (!row?.id) return;
        if (row.status !== 'matched') return;
        if (old && typeof old.status === 'string' && old.status === 'matched') return;
        if (row.requester_id !== userId && row.matched_user_id !== userId) return;

        void (async () => {
          await refreshUnread();
          if (disposed) return;
          const roomId = row.chat_room_id ?? null;
          if (roomId && handlers.getActiveRoomId() === roomId) return;

          const area = typeof row.area_label === 'string' ? row.area_label.trim() : '';
          handlers.onToast({
            id: `match-${row.id}`,
            title: 'Pickup match',
            body: 'Your instant pickup was matched. Open chat to share your confirmation code.',
            roomId,
            kind: 'match',
            context: area ? `Instant Pickup · ${area}` : 'Instant Pickup',
          });
        })();
      },
    )
    .subscribe();
  channels.push(matchChannel);

  const onVisibility = () => {
    void refreshUnread();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  return () => {
    disposed = true;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    for (const channel of channels) {
      void client.removeChannel(channel);
    }
  };
}

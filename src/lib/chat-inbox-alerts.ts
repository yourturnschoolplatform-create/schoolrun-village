import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { chatApi, type ChatRoom } from './chat-api';

export type InboxToast = {
  id: string;
  title: string;
  body: string;
  roomId: string | null;
  kind: 'chat' | 'match';
};

export type ChatInboxAlertHandlers = {
  onUnreadTotal: (total: number) => void;
  onToast: (toast: InboxToast) => void;
  /** Room currently open in the Messages transcript — suppress toast for that thread. */
  getActiveRoomId: () => string | null;
  /** True when the Messages tab (and optionally a room) is the focused view. */
  isMessagesView: () => boolean;
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

/**
 * Live inbox: unread badge total + Karrot-style toast for messages / match updates
 * when the parent is not already viewing that thread.
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
        if (!row?.room_id || !row.sender_id || row.sender_id === userId) return;

        const activeRoomId = handlers.getActiveRoomId();
        const viewingThisThread = handlers.isMessagesView() && activeRoomId === row.room_id;
        void refreshUnread();

        if (viewingThisThread) return;

        const peer = rooms.find((room) => room.id === row.room_id)?.peerDisplayName || 'Parent';
        const preview = (row.body || 'New message').trim().slice(0, 80);
        handlers.onToast({
          id: row.id || `${row.room_id}-${Date.now()}`,
          title: peer,
          body: preview,
          roomId: row.room_id,
          kind: 'chat',
        });
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
        };
        const old = payload.old as { status?: string } | undefined;
        if (!row?.id) return;
        // Prefer transition-to-matched. If Realtime omits OLD (no FULL replica identity),
        // still toast once when status is matched and we are a party.
        if (row.status !== 'matched') return;
        if (old && typeof old.status === 'string' && old.status === 'matched') return;
        if (row.requester_id !== userId && row.matched_user_id !== userId) return;

        void refreshUnread();
        handlers.onToast({
          id: `match-${row.id}`,
          title: 'Pickup match',
          body: 'Your instant pickup was matched. Open chat to share your confirmation code.',
          roomId: row.chat_room_id ?? null,
          kind: 'match',
        });
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

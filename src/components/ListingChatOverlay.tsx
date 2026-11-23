import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChatRoom } from '../lib/chat-api';
import { ChatRoomView } from './ChatHub';

/**
 * Karrot-style full-screen marketplace chat over the current Market view.
 * Keeps listing context; avoids a hard jump to the Messages tab.
 */
export function ListingChatOverlay({
  client,
  userId,
  room,
  onClose,
  onOpenInMessages,
}: {
  client: SupabaseClient;
  userId: string;
  room: ChatRoom;
  onClose: () => void;
  onOpenInMessages: () => void;
}) {
  return (
    <div className="listing-chat-overlay" role="presentation">
      <div
        className="listing-chat-overlay__panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Chat with ${room.peerDisplayName}`}
      >
        <ChatRoomView
          client={client}
          userId={userId}
          room={room}
          backLabel="Back to listing"
          listLabel="Back to messages"
          onBack={onClose}
          onBackToList={onOpenInMessages}
        />
      </div>
    </div>
  );
}

import { useEffect } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChatRoom } from '../lib/chat-api';
import { ChatRoomView } from './ChatHub';

/**
 * Karrot-style full-screen marketplace chat over the current Market view.
 * Uses 100dvh on mobile; centered card on desktop. Locks background scroll.
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
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

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
          fullScreen
          backLabel="Back to listing"
          listLabel="Chat list"
          onBack={onClose}
          onBackToList={onOpenInMessages}
        />
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseHouseholdCodeCard } from '../../shared/household-code-message';
import { chatApi, type ChatMessage, type ChatRoom } from '../lib/chat-api';
import { scheduleApi } from '../lib/schedule-api';

function formatClock(value: string): string {
  return new Date(value).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
}

function marketplaceAskLabel(room: ChatRoom): string {
  const schedule = room.schedule;
  if (schedule.askAudDisplay) return schedule.askAudDisplay;
  const offer = (schedule.offerLabel || '').trim().toUpperCase();
  if (offer === 'SWAP') return 'Swap';
  if (offer === 'SALE') return 'Sale';
  return 'Free Share';
}

function MarketplaceListingPin({ room }: { room: ChatRoom }) {
  const schedule = room.schedule;
  const title = schedule.listingTitle || schedule.weekdayLabel || 'Marketplace listing';
  const ask = marketplaceAskLabel(room);
  const cover = schedule.coverSrc?.trim() || null;

  return (
    <header className="chat-pin chat-pin--listing" aria-label="Pinned marketplace listing">
      <div className="chat-pin__listing">
        <div className="chat-pin__thumb" aria-hidden={!cover}>
          {cover ? (
            <img src={cover} alt="" className="chat-pin__image" />
          ) : (
            <span className="chat-pin__placeholder">No photo</span>
          )}
        </div>
        <div className="chat-pin__copy">
          <p className="eyebrow">Marketplace chat</p>
          <strong>{title}</strong>
          <p className="chat-pin__ask">{ask}</p>
          <small>
            {room.peerDisplayName}
            {schedule.areaLabel ? ` · ${schedule.areaLabel}` : ''}
            {' · School pickup'}
          </small>
        </div>
      </div>
    </header>
  );
}

function SchedulePin({ room }: { room: ChatRoom }) {
  const schedule = room.schedule;
  if (schedule.pinKind === 'marketplace') {
    return <MarketplaceListingPin room={room} />;
  }
  const windowLabel = schedule.windowStart && schedule.windowEnd
    ? `${schedule.windowStart.slice(0, 5)}–${schedule.windowEnd.slice(0, 5)}`
    : null;
  return (
    <header className="chat-pin" aria-label="Pinned school-run schedule">
      <p className="eyebrow">School-run context</p>
      <strong>{room.peerDisplayName}</strong>
      <p>
        {schedule.weekdayLabel}
        {windowLabel ? ` · ${windowLabel}` : ''}
        {' · '}
        {schedule.areaLabel}
      </p>
      <small>
        {schedule.direction === 'pickup' ? 'Pickup' : 'Drop-off'}
        {' · '}
        {schedule.intent === 'can_help' ? 'Can help' : 'Needs help'}
      </small>
    </header>
  );
}

function ChatRoomView({
  client,
  userId,
  room,
  onBack,
}: {
  client: SupabaseClient;
  userId: string;
  room: ChatRoom;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmedCodes, setConfirmedCodes] = useState<Record<string, true>>({});
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await chatApi.listMessages(client, room.id);
      setMessages(rows);
      await chatApi.markRead(client, room.id);
      setError(null);
    } catch {
      setError('Messages could not be loaded for this chat.');
    }
  }, [client, room.id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  useEffect(() => {
    const channel = chatApi.subscribeMessages(client, room.id, (row) => {
      setMessages((current) => {
        if (current.some((message) => message.id === row.id)) return current;
        return [...current, {
          id: row.id,
          roomId: row.room_id,
          senderId: row.sender_id,
          body: row.body,
          createdAt: row.created_at,
          mine: row.sender_id === userId,
          readByPeer: false,
        }];
      });
      if (row.sender_id !== userId) {
        void chatApi.markRead(client, room.id).then(() => undefined).catch(() => undefined);
      }
    });
    return () => { void client.removeChannel(channel); };
  }, [client, room.id, userId]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const sent = await chatApi.send(client, room.id, body);
      setMessages((current) => (current.some((message) => message.id === sent.id) ? current : [...current, sent]));
      setDraft('');
    } catch {
      setError('That message could not be sent. Keep it phone-free and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmCode(code: string, messageId: string) {
    if (busy || confirmedCodes[messageId]) return;
    setBusy(true);
    setError(null);
    try {
      await scheduleApi.claimHouseholdCode(client, code);
      setConfirmedCodes((current) => ({ ...current, [messageId]: true }));
    } catch {
      setError('That confirmation code could not be accepted.');
    } finally {
      setBusy(false);
    }
  }

  const emptyCopy = room.schedule.pinKind === 'marketplace'
    ? 'No messages yet. Ask about pickup timing for this listing.'
    : 'No messages yet. Say hello about this school run.';

  return (
    <section className="chat-room" aria-labelledby="chat-room-title">
      <button className="text-button" type="button" onClick={onBack}>Back to messages</button>
      <SchedulePin room={room} />
      <h2 id="chat-room-title" className="visually-hidden">Chat with {room.peerDisplayName}</h2>
      <div className="chat-transcript" role="log" aria-live="polite">
        {messages.length === 0 && <p className="section-copy">{emptyCopy}</p>}
        {messages.map((message) => {
          const code = parseHouseholdCodeCard(message.body);
          if (code) {
            const accepted = Boolean(confirmedCodes[message.id]);
            return (
              <div
                key={message.id}
                className={message.mine ? 'household-code-card household-code-card--mine' : 'household-code-card'}
              >
                <p className="eyebrow">Household confirmation</p>
                <strong>One-time match code</strong>
                <code className="household-code-card__code">{message.mine ? code : '••••••••••••'}</code>
                {!message.mine ? (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy || accepted}
                    onClick={() => void confirmCode(code, message.id)}
                  >
                    {accepted ? '✅ Match confirmed' : 'Confirm & Accept Match'}
                  </button>
                ) : (
                  <p className="field-help">Waiting for your match to confirm.</p>
                )}
                <footer>
                  <time dateTime={message.createdAt}>{formatClock(message.createdAt)}</time>
                </footer>
              </div>
            );
          }
          return (
            <div
              key={message.id}
              className={message.mine ? 'chat-bubble chat-bubble--mine' : 'chat-bubble chat-bubble--theirs'}
            >
              <p>{message.body}</p>
              <footer>
                <time dateTime={message.createdAt}>{formatClock(message.createdAt)}</time>
                {message.mine && (
                  <span className="chat-receipt" aria-label={message.readByPeer ? 'Read' : 'Sent'}>
                    {message.readByPeer ? 'Read' : 'Sent'}
                  </span>
                )}
              </footer>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      {error && <p className="notice notice--red" role="alert">{error}</p>}
      <form className="chat-composer" onSubmit={(event) => void send(event)}>
        <label className="visually-hidden" htmlFor={`chat-draft-${room.id}`}>Message</label>
        <textarea
          id={`chat-draft-${room.id}`}
          rows={2}
          maxLength={2000}
          value={draft}
          disabled={busy}
          placeholder="Write a short, phone-free message…"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button className="primary-button" type="submit" disabled={busy || !draft.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>
    </section>
  );
}

/**
 * Direct 1:1 parent chat inbox. Australian English. No phones, photos or surnames in copy.
 */
export function ChatHub({
  client,
  userId,
  initialRoom = null,
  onBack,
}: {
  client: SupabaseClient;
  userId: string;
  initialRoom?: ChatRoom | null;
  onBack?: () => void;
}) {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [active, setActive] = useState<ChatRoom | null>(initialRoom);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setRooms(await chatApi.listRooms(client));
      setMessage(null);
    } catch {
      setMessage('Your messages could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (initialRoom) setActive(initialRoom);
  }, [initialRoom]);

  if (active) {
    return (
      <ChatRoomView
        client={client}
        userId={userId}
        room={active}
        onBack={() => { setActive(null); void refresh(); }}
      />
    );
  }

  return (
    <section className="chat-hub" aria-labelledby="chat-hub-title">
      <div className="schedule-hero">
        <p className="eyebrow">Direct messages</p>
        <h1 id="chat-hub-title">Chat about a school run.</h1>
        <p className="section-copy">
          Private 1:1 chats stay pinned to a weekday, time and suburb. No phones, photos or full names.
        </p>
      </div>
      {onBack && <button className="text-button" type="button" onClick={onBack}>Back</button>}
      {message && <p className="notice notice--amber" role="status">{message}</p>}
      {loading && <p className="section-copy">Loading your chats…</p>}
      {!loading && rooms.length === 0 && (
        <p className="section-copy">
          No chats yet. Open one from an accepted swap in Matches.
        </p>
      )}
      <ul className="chat-inbox">
        {rooms.map((room) => {
          const marketplace = room.schedule.pinKind === 'marketplace';
          const subtitle = marketplace
            ? `${room.schedule.listingTitle || room.schedule.weekdayLabel} · ${marketplaceAskLabel(room)}`
            : `${room.schedule.weekdayLabel} · ${room.schedule.windowStart.slice(0, 5)} · ${room.schedule.areaLabel}`;
          return (
            <li key={room.id}>
              <button type="button" className="chat-inbox__item" onClick={() => setActive(room)}>
                <div>
                  <strong>{room.peerDisplayName}</strong>
                  <span>{subtitle}</span>
                </div>
                <p>{room.lastMessageBody ?? (marketplace ? 'Ask about this listing' : 'Start the conversation')}</p>
                {room.unreadCount > 0 && (
                  <em className="chat-inbox__unread" aria-label={`${room.unreadCount} unread`}>
                    {room.unreadCount}
                  </em>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

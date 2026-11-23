import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseHouseholdCodeCard } from '../../shared/household-code-message';
import { chatApi, type ChatMessage, type ChatRoom } from '../lib/chat-api';
import { scheduleApi } from '../lib/schedule-api';
import { PushNotifyToggle } from './PushNotifyToggle';

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

function peerContextLine(room: ChatRoom): string {
  const schedule = room.schedule;
  const bits: string[] = [];
  if (schedule.areaLabel?.trim()) bits.push(schedule.areaLabel.trim());
  if (schedule.pinKind === 'marketplace') bits.push('School pickup');
  else if (schedule.pinKind === 'discussion') bits.push('School thread');
  else if (schedule.weekdayLabel) bits.push(schedule.weekdayLabel);
  return bits.join(' · ') || 'SchoolRun Village';
}

function isPricedSaleListing(room: ChatRoom): boolean {
  const schedule = room.schedule;
  if (schedule.pinKind !== 'marketplace') return false;
  const offer = (schedule.offerLabel || '').trim().toUpperCase();
  const cents = schedule.askAudCents;
  return offer === 'SALE' && typeof cents === 'number' && Number.isFinite(cents) && cents >= 100;
}

function formatOfferAud(cents: number): string {
  const dollars = cents / 100;
  if (Number.isInteger(dollars)) return `$${dollars} AUD`;
  return `$${dollars.toFixed(2)} AUD`;
}

function buildOfferMessage(listedCents: number, offerCents: number): string {
  return `Quick offer: ${formatOfferAud(offerCents)} (listed ${formatOfferAud(listedCents)}). Happy to arrange suburb pickup.`;
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
          <p className="eyebrow">Listing</p>
          <strong>{title}</strong>
          <p className="chat-pin__ask">{ask}</p>
          <small>
            {schedule.areaLabel ? `${schedule.areaLabel} · ` : ''}
            School pickup
          </small>
        </div>
      </div>
    </header>
  );
}

function ThreadSummaryPin({ room }: { room: ChatRoom }) {
  const schedule = room.schedule;
  const title = schedule.threadTitle || schedule.weekdayLabel || 'School discussion';

  return (
    <header className="chat-pin chat-pin--thread" aria-label="Pinned discussion thread">
      <div className="chat-pin__listing">
        <div className="chat-pin__thumb chat-pin__thumb--thread" aria-hidden="true">
          <span className="chat-pin__placeholder">Thread</span>
        </div>
        <div className="chat-pin__copy">
          <p className="eyebrow">Discussion</p>
          <strong>{title}</strong>
          <small>
            {schedule.areaLabel ? `${schedule.areaLabel} · ` : ''}
            School thread
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
  if (schedule.pinKind === 'discussion') {
    return <ThreadSummaryPin room={room} />;
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

export function ChatRoomView({
  client,
  userId,
  room,
  onBack,
  onBackToList,
  backLabel = 'Back',
  listLabel = 'Chat list',
  fullScreen = false,
}: {
  client: SupabaseClient;
  userId: string;
  room: ChatRoom;
  onBack: () => void;
  /** Optional second action (e.g. jump to Messages inbox). Defaults to onBack. */
  onBackToList?: () => void;
  backLabel?: string;
  listLabel?: string;
  /** True when hosted in ListingChatOverlay — fills 100dvh without nested chrome. */
  fullScreen?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmedCodes, setConfirmedCodes] = useState<Record<string, true>>({});
  const [customOfferDollars, setCustomOfferDollars] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const listedCents = room.schedule.askAudCents ?? null;
  const showQuickOffers = isPricedSaleListing(room) && listedCents != null;

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const node = bottomRef.current;
    if (!node) return;
    node.scrollIntoView({ behavior, block: 'end' });
  }, []);

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
    // Instant jump on first paint / room change; smooth for later updates.
    scrollToLatest(messages.length <= 1 ? 'auto' : 'smooth');
  }, [messages.length, room.id, scrollToLatest]);

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

  async function sendBody(raw: string, options?: { clearDraft?: boolean }) {
    const body = raw.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const sent = await chatApi.send(client, room.id, body);
      setMessages((current) => (current.some((message) => message.id === sent.id) ? current : [...current, sent]));
      if (options?.clearDraft !== false) setDraft('');
      window.requestAnimationFrame(() => {
        scrollToLatest('smooth');
        textareaRef.current?.focus();
      });
    } catch {
      setError('That message could not be sent. Keep it phone-free and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    await sendBody(draft);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  }

  async function sendDiscountOffer(discountDollars: number) {
    if (!listedCents || busy) return;
    const offerCents = listedCents - discountDollars * 100;
    if (offerCents < 100) {
      setError('That offer would be below $1 AUD. Try a smaller discount or a custom amount.');
      return;
    }
    await sendBody(buildOfferMessage(listedCents, offerCents), { clearDraft: false });
  }

  async function sendAvailabilityAsk() {
    await sendBody('Hi — is this still available for suburb pickup?', { clearDraft: false });
  }

  async function sendCustomOffer(event: FormEvent) {
    event.preventDefault();
    if (!listedCents || busy) return;
    const cleaned = customOfferDollars.trim().replace(/[$,\s]/g, '').replace(/aud/gi, '');
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
      setError('Enter a valid AUD offer (for example 45 or 45.00).');
      return;
    }
    const dollars = Number(cleaned);
    const offerCents = Math.round(dollars * 100);
    if (!Number.isFinite(offerCents) || offerCents < 100 || offerCents > 99_999_900) {
      setError('Offer must be between $1 and $999999 AUD.');
      return;
    }
    setCustomOfferDollars('');
    await sendBody(buildOfferMessage(listedCents, offerCents), { clearDraft: false });
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
    : room.schedule.pinKind === 'discussion'
      ? 'No messages yet. Continue this school discussion privately.'
      : 'No messages yet. Say hello about this school run.';

  const canSend = Boolean(draft.trim()) && !busy;
  const goToList = onBackToList ?? onBack;
  const discountChips = showQuickOffers && listedCents != null
    ? [5, 10].filter((dollars) => listedCents - dollars * 100 >= 100)
    : [];

  return (
    <section
      className={
        fullScreen
          ? 'chat-room chat-room--karrot chat-room--fullscreen'
          : 'chat-room chat-room--karrot'
      }
      aria-labelledby="chat-room-title"
      data-pin={room.schedule.pinKind || 'schedule'}
    >
      <header className="chat-room__top">
        <button
          type="button"
          className="chat-room__back"
          onClick={onBack}
          aria-label={backLabel}
        >
          <span aria-hidden="true">←</span>
        </button>
        <div className="chat-room__identity">
          <h2 id="chat-room-title">{room.peerDisplayName}</h2>
          <p>{peerContextLine(room)}</p>
        </div>
        <button type="button" className="chat-room__list-link" onClick={goToList}>
          {listLabel}
        </button>
      </header>

      <div className="chat-room__pin-sticky">
        <SchedulePin room={room} />
        {room.schedule.pinKind === 'marketplace' ? (
          <div className="chat-quick-offers" aria-label="Quick replies">
            {showQuickOffers ? (
              <>
                <p className="chat-quick-offers__label">Quick offer</p>
                <div className="chat-quick-offers__chips" role="group" aria-label="Price offer chips">
                  {discountChips.map((dollars) => (
                    <button
                      key={dollars}
                      type="button"
                      className="chat-quick-offers__chip"
                      disabled={busy}
                      onClick={() => { void sendDiscountOffer(dollars); }}
                    >
                      −${dollars} AUD
                    </button>
                  ))}
                  <button
                    type="button"
                    className="chat-quick-offers__chip"
                    disabled={busy}
                    onClick={() => { void sendAvailabilityAsk(); }}
                  >
                    Ask availability
                  </button>
                </div>
                <form className="chat-quick-offers__custom" onSubmit={(event) => void sendCustomOffer(event)}>
                  <label className="visually-hidden" htmlFor={`chat-offer-${room.id}`}>
                    Custom AUD offer
                  </label>
                  <span aria-hidden="true">$</span>
                  <input
                    id={`chat-offer-${room.id}`}
                    inputMode="decimal"
                    placeholder="Custom AUD"
                    value={customOfferDollars}
                    disabled={busy}
                    onChange={(event) => setCustomOfferDollars(event.target.value)}
                  />
                  <button type="submit" disabled={busy || !customOfferDollars.trim()}>
                    Offer
                  </button>
                </form>
              </>
            ) : (
              <div className="chat-quick-offers__chips" role="group" aria-label="Quick replies">
                <button
                  type="button"
                  className="chat-quick-offers__chip"
                  disabled={busy}
                  onClick={() => { void sendAvailabilityAsk(); }}
                >
                  Ask availability
                </button>
                <button
                  type="button"
                  className="chat-quick-offers__chip"
                  disabled={busy}
                  onClick={() => {
                    void sendBody('Happy to collect from suburb meetup after school.', { clearDraft: false });
                  }}
                >
                  Suburb pickup OK
                </button>
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div
        ref={transcriptRef}
        className="chat-transcript chat-transcript--karrot"
        role="log"
        aria-live="polite"
      >
        {messages.length === 0 && <p className="chat-transcript__empty">{emptyCopy}</p>}
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
                    {accepted ? 'Match confirmed' : 'Confirm & Accept Match'}
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
        <div ref={bottomRef} className="chat-transcript__anchor" />
      </div>

      {error && <p className="notice notice--red chat-room__error" role="alert">{error}</p>}

      <form className="chat-composer chat-composer--dock" onSubmit={(event) => void send(event)}>
        <label className="visually-hidden" htmlFor={`chat-draft-${room.id}`}>Message</label>
        <textarea
          ref={textareaRef}
          id={`chat-draft-${room.id}`}
          rows={1}
          maxLength={2000}
          value={draft}
          disabled={busy}
          placeholder="Message… (Enter to send)"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onComposerKeyDown}
        />
        <button
          className={canSend ? 'chat-composer__send chat-composer__send--active' : 'chat-composer__send'}
          type="submit"
          disabled={!canSend}
        >
          {busy ? '…' : 'Send'}
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
  onActiveRoomChange,
  onUnreadChange,
}: {
  client: SupabaseClient;
  userId: string;
  initialRoom?: ChatRoom | null;
  onBack?: () => void;
  onActiveRoomChange?: (roomId: string | null) => void;
  onUnreadChange?: (total: number) => void;
}) {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [active, setActive] = useState<ChatRoom | null>(initialRoom);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await chatApi.listRooms(client);
      setRooms(next);
      onUnreadChange?.(next.reduce((sum, room) => sum + (room.unreadCount || 0), 0));
      setMessage(null);
    } catch {
      setMessage('Your messages could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [client, onUnreadChange]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (initialRoom) setActive(initialRoom);
  }, [initialRoom]);

  useEffect(() => {
    onActiveRoomChange?.(active?.id ?? null);
  }, [active?.id, onActiveRoomChange]);

  if (active) {
    return (
      <ChatRoomView
        client={client}
        userId={userId}
        room={active}
        backLabel="Back"
        listLabel="Chat list"
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
      <PushNotifyToggle client={client} />
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
          const discussion = room.schedule.pinKind === 'discussion';
          const subtitle = marketplace
            ? `${room.schedule.listingTitle || room.schedule.weekdayLabel} · ${marketplaceAskLabel(room)}`
            : discussion
              ? `${room.schedule.threadTitle || room.schedule.weekdayLabel} · Discussion`
              : `${room.schedule.weekdayLabel} · ${room.schedule.windowStart.slice(0, 5)} · ${room.schedule.areaLabel}`;
          return (
            <li key={room.id}>
              <button type="button" className="chat-inbox__item" onClick={() => setActive(room)}>
                <div>
                  <strong>{room.peerDisplayName}</strong>
                  <span>{subtitle}</span>
                </div>
                <p>
                  {room.lastMessageBody
                    ?? (marketplace
                      ? 'Ask about this listing'
                      : discussion
                        ? 'Continue this discussion'
                        : 'Start the conversation')}
                </p>
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

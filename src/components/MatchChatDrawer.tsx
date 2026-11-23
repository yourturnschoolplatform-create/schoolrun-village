import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  directionLabelEnglish,
  intentLabelEnglish,
} from '../../shared/au-location';
import { encodeHouseholdCodeCard, parseHouseholdCodeCard } from '../../shared/household-code-message';
import type { SchoolRunDirection, ScheduleIntent } from '../../shared/schedules';
import { chatApi, type ChatMessage, type ChatRoom } from '../lib/chat-api';
import { roomContextLabel } from '../lib/chat-inbox-alerts';
import { scheduleApi } from '../lib/schedule-api';

export type MatchPickupSummary = {
  intent: ScheduleIntent | string;
  direction: SchoolRunDirection | string;
  targetDate: string;
  areaLabel: string;
  notes?: string | null;
  status?: string;
  pickupAt?: string | null;
};

function formatClock(value: string): string {
  return new Date(value).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
}

function formatWindow(start: string | undefined, end: string | undefined): string | null {
  if (!start) return null;
  const a = start.slice(0, 5);
  const b = end?.slice(0, 5);
  return b ? `${a}–${b}` : a;
}

function pickupSpotLabel(notes: string | null | undefined, areaLabel: string): string {
  const text = (notes || '').toLowerCase();
  if (text.includes('school gate') || text.includes('gate')) return 'School gate';
  return areaLabel?.trim() || 'School gate';
}

function seatsFromNotes(notes: string | null | undefined): string | null {
  const match = (notes || '').match(/(\d+)\s*seats?/i);
  if (!match) return null;
  const count = Number(match[1]);
  return `${count} seat${count === 1 ? '' : 's'}`;
}

/**
 * Karrot-style full-screen Instant Pickup match chat.
 * Keeps one-time match code + Realtime; opens immediately after Request Match.
 */
export function MatchChatDrawer({
  client,
  userId,
  room,
  pickupSummary = null,
  onClose,
  onOpenInMessages,
  onToast,
}: {
  client: SupabaseClient;
  userId: string;
  room: ChatRoom;
  pickupSummary?: MatchPickupSummary | null;
  onClose: () => void;
  onOpenInMessages?: () => void;
  onToast?: (message: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmedCodes, setConfirmedCodes] = useState<Record<string, true>>({});
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const schedule = room.schedule;
  const intent = pickupSummary?.intent || schedule.intent;
  const direction = pickupSummary?.direction || schedule.direction;
  const targetDate = pickupSummary?.targetDate || schedule.weekdayLabel;
  const areaLabel = pickupSummary?.areaLabel || schedule.areaLabel || 'Local suburb';
  const notes = pickupSummary?.notes ?? null;
  const status = pickupSummary?.status || 'matched';
  const windowLabel = formatWindow(schedule.windowStart, schedule.windowEnd);
  const pickupAtLabel = pickupSummary?.pickupAt
    ? formatClock(pickupSummary.pickupAt)
    : null;
  const spot = pickupSpotLabel(notes, areaLabel);
  const seats = seatsFromNotes(notes);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, []);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const rows = await chatApi.listMessages(client, room.id);
      setMessages(rows);
      await chatApi.markRead(client, room.id);
      setError(null);
    } catch {
      setError('Match chat messages could not be loaded.');
    }
  }, [client, room.id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
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
        void chatApi.markRead(client, room.id).catch(() => undefined);
      }
    });
    return () => { void client.removeChannel(channel); };
  }, [client, room.id, userId]);

  async function sendBody(raw: string, options?: { clearDraft?: boolean }) {
    const body = raw.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    const optimisticId = `local-${Date.now()}`;
    const optimistic: ChatMessage = {
      id: optimisticId,
      roomId: room.id,
      senderId: userId,
      body,
      createdAt: new Date().toISOString(),
      mine: true,
      readByPeer: false,
    };
    setMessages((current) => [...current, optimistic]);
    if (options?.clearDraft !== false) setDraft('');
    try {
      const sent = await chatApi.send(client, room.id, body, {
        context: roomContextLabel(room) || 'Instant Pickup',
        listingId: room.schedule.listingId ?? null,
      });
      setMessages((current) => current.map((message) => (
        message.id === optimisticId ? sent : message
      )));
      window.requestAnimationFrame(() => {
        scrollToLatest('smooth');
        textareaRef.current?.focus();
      });
    } catch (err) {
      console.error('Failed to send chat message:', err);
      setMessages((current) => current.filter((message) => message.id !== optimisticId));
      if (options?.clearDraft !== false) setDraft(body);
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

  async function sendConfirmationCode() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await scheduleApi.createHouseholdCode(client);
      const card = encodeHouseholdCodeCard(created.code);
      const sent = await chatApi.send(client, room.id, card, {
        context: roomContextLabel(room) || 'Instant Pickup',
        listingId: room.schedule.listingId ?? null,
      });
      setMessages((current) => (current.some((message) => message.id === sent.id) ? current : [...current, sent]));
      onToast?.('Confirmation code sent in chat.');
      window.requestAnimationFrame(() => scrollToLatest('smooth'));
    } catch {
      setError('A confirmation code could not be created or sent right now.');
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
      onToast?.('Household confirmed — you are matched and excluded from future listings together.');
    } catch {
      setError('That confirmation code could not be accepted. Ask your match to send a fresh code.');
    } finally {
      setBusy(false);
    }
  }

  const canSend = Boolean(draft.trim()) && !busy;
  const goToList = onOpenInMessages ?? onClose;

  return (
    <div className="listing-chat-overlay listing-chat-overlay--match" role="presentation">
      <div
        className="listing-chat-overlay__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="match-chat-title"
      >
        <section className="chat-room chat-room--karrot chat-room--fullscreen match-chat-room">
          <header className="chat-room__top">
            <button
              type="button"
              className="chat-room__back"
              onClick={onClose}
              aria-label="Back to pickup board"
            >
              <span aria-hidden="true">←</span>
            </button>
            <div className="chat-room__identity">
              <h2 id="match-chat-title">{room.peerDisplayName}</h2>
              <p>{areaLabel} · Pickup match</p>
            </div>
            <button type="button" className="chat-room__list-link" onClick={goToList}>
              Chat list
            </button>
          </header>

          <div className="chat-room__pin-sticky">
            <header className="chat-pin chat-pin--pickup" aria-label="Pinned pickup match">
              <p className="eyebrow">Instant pickup match</p>
              <strong>
                {intentLabelEnglish(intent as ScheduleIntent)}
                {' · '}
                {directionLabelEnglish(direction as SchoolRunDirection)}
              </strong>
              <p>
                {targetDate}
                {windowLabel ? ` · ${windowLabel}` : ''}
                {pickupAtLabel ? ` · around ${pickupAtLabel}` : ''}
              </p>
              <small>
                {seats ? `${seats} · ` : ''}
                {spot}
                {' · '}
                {status === 'matched' ? 'Matched' : status}
                {' · One-time match code in chat'}
              </small>
            </header>

            <div className="chat-quick-offers" aria-label="Pickup quick actions">
              <p className="chat-quick-offers__label">Quick actions</p>
              <div className="chat-quick-offers__chips" role="group" aria-label="Pickup coordination chips">
                <button
                  type="button"
                  className="chat-quick-offers__chip"
                  disabled={busy}
                  onClick={() => { void sendBody('On my way — see you soon.', { clearDraft: false }); }}
                >
                  On my way
                </button>
                <button
                  type="button"
                  className="chat-quick-offers__chip"
                  disabled={busy}
                  onClick={() => { void sendBody('I am at the school gate now.', { clearDraft: false }); }}
                >
                  At the school gate
                </button>
                <button
                  type="button"
                  className="chat-quick-offers__chip"
                  disabled={busy}
                  onClick={() => { void sendBody('Running a few minutes late — still coming.', { clearDraft: false }); }}
                >
                  Running late
                </button>
                <button
                  type="button"
                  className="chat-quick-offers__chip chat-quick-offers__chip--accent"
                  disabled={busy}
                  onClick={() => { void sendConfirmationCode(); }}
                >
                  Share match code
                </button>
              </div>
            </div>
          </div>

          <div
            className="chat-transcript chat-transcript--karrot"
            role="log"
            aria-live="polite"
          >
            {messages.length === 0 ? (
              <p className="chat-transcript__empty">
                Match chat is open. Share your one-time match code or send a quick update.
              </p>
            ) : null}
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
                    <p className="field-help">
                      {message.mine
                        ? 'Waiting for your match to confirm this code in chat.'
                        : 'Confirm to accept the household match and stop future listing overlaps.'}
                    </p>
                    {!message.mine ? (
                      <button
                        type="button"
                        className="primary-button"
                        disabled={busy || accepted}
                        onClick={() => void confirmCode(code, message.id)}
                      >
                        {accepted ? 'Match confirmed' : 'Confirm & Accept Match'}
                      </button>
                    ) : null}
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

          {error ? <p className="notice notice--red chat-room__error" role="alert">{error}</p> : null}

          <form className="chat-composer chat-composer--dock" onSubmit={(event) => void send(event)}>
            <label className="visually-hidden" htmlFor={`match-chat-draft-${room.id}`}>Message</label>
            <textarea
              ref={textareaRef}
              id={`match-chat-draft-${room.id}`}
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
      </div>
    </div>
  );
}

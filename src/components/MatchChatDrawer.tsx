import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { encodeHouseholdCodeCard, parseHouseholdCodeCard } from '../../shared/household-code-message';
import { chatApi, type ChatMessage, type ChatRoom } from '../lib/chat-api';
import { scheduleApi } from '../lib/schedule-api';

function formatClock(value: string): string {
  return new Date(value).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
}

/**
 * Private Instant Pickup match chat drawer with household confirmation code sharing.
 */
export function MatchChatDrawer({
  client,
  userId,
  room,
  onClose,
  onToast,
}: {
  client: SupabaseClient;
  userId: string;
  room: ChatRoom;
  onClose: () => void;
  onToast?: (message: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmedCodes, setConfirmedCodes] = useState<Record<string, true>>({});
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
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

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.trim();
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
    setDraft('');
    try {
      const sent = await chatApi.send(client, room.id, body);
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
      setDraft(body);
      setError('That message could not be sent. Keep it phone-free and try again.');
    } finally {
      setBusy(false);
    }
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
      const sent = await chatApi.send(client, room.id, card);
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

  return (
    <div className="match-chat-overlay" role="presentation" onClick={onClose}>
      <section
        className="match-chat-drawer match-chat-drawer--karrot"
        role="dialog"
        aria-modal="true"
        aria-labelledby="match-chat-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="match-chat-drawer__top">
          <button type="button" className="chat-room__back" onClick={onClose} aria-label="Close chat">
            <span aria-hidden="true">←</span>
          </button>
          <div className="chat-room__identity">
            <p className="eyebrow">Private match chat</p>
            <h2 id="match-chat-title">{room.peerDisplayName}</h2>
            <p>Share a one-time household confirmation code to lock the match.</p>
          </div>
          <button type="button" className="chat-room__list-link" onClick={onClose}>Close</button>
        </header>

        <button
          type="button"
          className="primary-button match-chat-drawer__send-code"
          disabled={busy}
          onClick={() => void sendConfirmationCode()}
        >
          Send my confirmation code
        </button>

        <div className="chat-transcript chat-transcript--karrot match-chat-drawer__transcript" role="log" aria-live="polite">
          {messages.length === 0 ? (
            <p className="chat-transcript__empty">No messages yet. Send your confirmation code or say hello.</p>
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
  );
}

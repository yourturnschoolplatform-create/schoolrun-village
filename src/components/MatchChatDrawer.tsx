import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
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
        void chatApi.markRead(client, room.id).catch(() => undefined);
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

  async function sendConfirmationCode() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await scheduleApi.createHouseholdCode(client);
      const sent = await chatApi.send(client, room.id, encodeHouseholdCodeCard(created.code));
      setMessages((current) => (current.some((message) => message.id === sent.id) ? current : [...current, sent]));
      onToast?.('Confirmation code sent in chat.');
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

  return (
    <div className="match-chat-overlay" role="presentation" onClick={onClose}>
      <section
        className="match-chat-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="match-chat-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="match-chat-drawer__head">
          <div>
            <p className="eyebrow">Private match chat</p>
            <h2 id="match-chat-title">{room.peerDisplayName}</h2>
            <p className="section-copy">Share a one-time household confirmation code to lock the match.</p>
          </div>
          <button type="button" className="text-button" onClick={onClose}>Close</button>
        </div>

        <button
          type="button"
          className="primary-button match-chat-drawer__send-code"
          disabled={busy}
          onClick={() => void sendConfirmationCode()}
        >
          📩 Send My Confirmation Code
        </button>

        <div className="chat-transcript match-chat-drawer__transcript" role="log" aria-live="polite">
          {messages.length === 0 ? (
            <p className="section-copy">No messages yet. Send your confirmation code or say hello.</p>
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
                      {accepted ? '✅ Match confirmed' : 'Confirm & Accept Match'}
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
                </footer>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {error ? <p className="notice notice--red" role="alert">{error}</p> : null}

        <form className="chat-composer" onSubmit={(event) => void send(event)}>
          <label className="visually-hidden" htmlFor={`match-chat-draft-${room.id}`}>Message</label>
          <textarea
            id={`match-chat-draft-${room.id}`}
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
    </div>
  );
}

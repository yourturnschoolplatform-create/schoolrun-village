import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SchoolRunDirection, ScheduleIntent } from '../../shared/schedules';
import {
  directionLabelEnglish,
  intentLabelEnglish,
  statusLabelEnglish,
} from '../../shared/au-location';
import { nonPaymentNoticeForTrade, PICKUP_NO_SHOW_POLICY_COPY } from '../../shared/payment-tracks';
import type { ChatRoom } from '../lib/chat-api';
import { instantPickupApi, type InstantPickupRequest } from '../lib/instant-pickup-api';
import { MatchChatDrawer } from './MatchChatDrawer';
import { ParentTrustBadge } from './ParentTrustBadge';

function formatClock(value: string): string {
  return new Date(value).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
}

function needsFinalCheckIn(item: InstantPickupRequest, nowMs: number): boolean {
  if (item.status !== 'matched' || item.checkInStatus !== 'pending' || !item.finalCheckAt) {
    return false;
  }
  if (!(item.mine || item.iAmMatched)) return false;
  const opensAt = new Date(item.finalCheckAt).getTime();
  const closesAt = item.pickupAt
    ? new Date(item.pickupAt).getTime()
    : opensAt + 30 * 60 * 1000;
  return nowMs >= opensAt && nowMs < closesAt;
}

const NOTE_CHIPS = [
  { id: 'seat', label: '👧 1 Seat', phrase: '1 seat' },
  { id: 'gate', label: '🎒 School Gate', phrase: 'School gate' },
  { id: 'ontime', label: '⏱️ On-time pickup', phrase: 'On-time pickup' },
] as const;

/**
 * Same-school today/tomorrow instant help board. Australian English. Suburb only.
 * Compose UI opens as a stepped bottom sheet when controlled by the home hero CTAs.
 */
export function InstantPickupBoard({
  client,
  userId,
  defaultSuburb = '',
  onOpenChat,
  composeOpen = false,
  onComposeOpenChange,
  presetIntent = null,
}: {
  client: SupabaseClient;
  userId?: string;
  defaultSuburb?: string;
  onOpenChat: (room: ChatRoom) => void;
  composeOpen?: boolean;
  onComposeOpenChange?: (open: boolean) => void;
  presetIntent?: ScheduleIntent | null;
}) {
  const [items, setItems] = useState<InstantPickupRequest[]>([]);
  const [intent, setIntent] = useState<ScheduleIntent>('need_help');
  const [direction, setDirection] = useState<SchoolRunDirection>('pickup');
  const [areaLabel, setAreaLabel] = useState(defaultSuburb.trim());
  const [suburbEditing, setSuburbEditing] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [matchRoom, setMatchRoom] = useState<ChatRoom | null>(null);
  const [selectedMatch, setSelectedMatch] = useState<InstantPickupRequest | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [composeStep, setComposeStep] = useState<1 | 2 | 3>(1);
  const resolvedUserId = userId ?? '';
  const registeredSuburb = useMemo(() => {
    const fromProp = defaultSuburb.trim();
    if (fromProp) return fromProp;
    const fromBoard = items.find((item) => item.schoolSuburb?.trim())?.schoolSuburb?.trim();
    return fromBoard ?? '';
  }, [defaultSuburb, items]);

  useEffect(() => {
    if (!composeOpen) return;
    if (presetIntent) {
      setIntent(presetIntent);
      setComposeStep(2);
    } else {
      setComposeStep(1);
    }
  }, [composeOpen, presetIntent]);

  const refresh = useCallback(async () => {
    try {
      setItems(await instantPickupApi.list(client));
      setMessage(null);
    } catch {
      setMessage('Instant pickup requests are available after school verification.');
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!registeredSuburb) return;
    setAreaLabel((current) => (current.trim() ? current : registeredSuburb));
  }, [registeredSuburb]);

  useEffect(() => {
    const schoolId = items[0]?.schoolId;
    if (!schoolId) return;
    const channel = instantPickupApi.subscribe(client, schoolId, () => { void refresh(); });
    return () => { void client.removeChannel(channel); };
  }, [client, items[0]?.schoolId, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const checkInItem = useMemo(
    () => items.find((item) => needsFinalCheckIn(item, nowMs)) ?? null,
    [items, nowMs],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (composeStep !== 3 || !areaLabel.trim() || busy) return;
    setBusy(true);
    try {
      await instantPickupApi.create(client, {
        intent,
        direction,
        areaLabel: areaLabel.trim(),
        notes: notes.trim() || null,
      });
      setNotes('');
      setMessage('Your instant request is on the school board.');
      onComposeOpenChange?.(false);
      setComposeStep(1);
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error && error.message
          ? error.message
          : 'That request could not be posted. Use a suburb label and keep notes phone-free.',
      );
    } finally {
      setBusy(false);
    }
  }

  function closeCompose() {
    onComposeOpenChange?.(false);
    setComposeStep(1);
  }

  async function cancel(id: string) {
    setBusy(true);
    try {
      await instantPickupApi.cancel(client, id);
      await refresh();
    } catch {
      setMessage('That request could not be cancelled.');
    } finally {
      setBusy(false);
    }
  }

  async function requestMatch(id: string) {
    setBusy(true);
    setMessage(null);
    try {
      const { data: sessionData, error: sessionError } = await client.auth.getSession();
      if (sessionError) {
        console.error('Request match detailed error:', sessionError);
        setMessage('Please sign in again, then finish school onboarding before requesting a match.');
        return;
      }
      if (!sessionData.session?.user?.id) {
        console.error('Request match detailed error:', { reason: 'empty_session', requestId: id });
        setMessage('Please sign in again, then finish school onboarding before requesting a match.');
        return;
      }
      // RPC: accept_instant_pickup_request(p_request_id uuid)
      const result = await instantPickupApi.accept(client, id);
      await refresh();
      setMatchRoom(result.chatRoom);
      setToast('Private match chat opened. You can send your confirmation code.');
      setMessage('Match requested. Share your household confirmation code in chat when ready.');
    } catch (err) {
      const cause =
        err instanceof Error && 'cause' in err ? (err as Error & { cause?: unknown }).cause : undefined;
      const bag = (value: unknown) => {
        if (!value || typeof value !== 'object') {
          return { message: String(value ?? ''), details: '', hint: '', code: undefined };
        }
        const row = value as Record<string, unknown>;
        return {
          message: typeof row.message === 'string' ? row.message : String(row.message ?? ''),
          details: typeof row.details === 'string' ? row.details : '',
          hint: typeof row.hint === 'string' ? row.hint : '',
          code: typeof row.code === 'string' ? row.code : undefined,
        };
      };
      const primary = bag(cause ?? err);
      console.error('Request match detailed error:', err);
      console.error('Request match detailed error:', {
        message: primary.message,
        details: primary.details,
        hint: primary.hint,
        code: primary.code,
        rpc: 'accept_instant_pickup_request',
        args: { p_request_id: id },
      });
      setMessage(
        err instanceof Error && err.message.trim()
          ? err.message
          : 'That match request could not be started right now.',
      );
    } finally {
      setBusy(false);
    }
  }

  function handleCardClick(matchItem: InstantPickupRequest) {
    setSelectedMatch(matchItem);
  }

  async function openMatchedChat(id: string, asDrawer = true) {
    setBusy(true);
    try {
      const room = await instantPickupApi.openChat(client, id);
      if (asDrawer) setMatchRoom(room);
      else onOpenChat(room);
    } catch {
      setMessage('That chat could not be opened yet.');
    } finally {
      setBusy(false);
    }
  }

  async function handleStartChat(item: InstantPickupRequest) {
    setSelectedMatch(item);
    if (!item.chatRoomId) {
      setMessage('Chat room is not ready yet.');
      return;
    }
    // Open the 1:1 room in the Messages tab (ScheduleHub view switch).
    await openMatchedChat(item.id, false);
    setSelectedMatch(null);
  }

  async function respondCheckIn(confirm: boolean) {
    if (!checkInItem || busy) return;
    setBusy(true);
    try {
      await instantPickupApi.checkIn(client, checkInItem.id, confirm);
      await refresh();
      setMessage(confirm
        ? 'Final check-in confirmed. Your school-run match stays active.'
        : 'Match released back to the school board.');
    } catch {
      setMessage('Final check-in could not be saved right now.');
    } finally {
      setBusy(false);
    }
  }

  function appendNoteChip(phrase: string) {
    setNotes((current) => {
      const trimmed = current.trim();
      if (!trimmed) return phrase;
      if (trimmed.toLowerCase().includes(phrase.toLowerCase())) return trimmed;
      return `${trimmed} · ${phrase}`;
    });
  }

  return (
    <section className="feed-section instant-board" aria-labelledby="instant-board-title">
      <div className="feed-section__intro">
        <p className="eyebrow">School board</p>
        <h2 id="instant-board-title">Live ask &amp; offer posts</h2>
        <p className="section-copy">Suburb only — no phones or addresses. Request Match opens a private chat.</p>
      </div>

      <div className="instant-policy-badges" aria-label="Instant pickup policies">
        <span className="instant-policy-badge" title={nonPaymentNoticeForTrade('pickup_dropoff')}>
          🆓 Free Handover
        </span>
        <button
          type="button"
          className="instant-policy-badge instant-policy-badge--button"
          aria-haspopup="dialog"
          aria-expanded={policyOpen}
          onClick={() => setPolicyOpen(true)}
        >
          🛡️ Trust Score Applied <span aria-hidden="true">ℹ️</span>
          <span className="visually-hidden">Open no-show trust policy</span>
        </button>
      </div>

      {policyOpen ? (
        <div className="instant-policy-overlay" role="presentation" onClick={() => setPolicyOpen(false)}>
          <aside
            className="instant-policy-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="instant-policy-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="instant-policy-modal__head">
              <h3 id="instant-policy-title">No-show &amp; trust policy</h3>
              <button type="button" className="text-button" onClick={() => setPolicyOpen(false)}>Close</button>
            </div>
            <p>{PICKUP_NO_SHOW_POLICY_COPY}</p>
            <p className="field-help">{nonPaymentNoticeForTrade('pickup_dropoff')}</p>
          </aside>
        </div>
      ) : null}

      {message && <p className="notice notice--teal" role="status">{message}</p>}
      {toast && <p className="notice notice--teal match-toast" role="status">{toast}</p>}
      {checkInItem && (
        <aside className="instant-board__checkin" role="dialog" aria-labelledby="instant-checkin-title">
          <p className="eyebrow">Final check-in</p>
          <h3 id="instant-checkin-title">Confirm this school-run match?</h3>
          <p>
            Pickup is at {checkInItem.pickupAt ? formatClock(checkInItem.pickupAt) : 'the scheduled time'}.
            Confirm to keep the match, or cancel to return it to the board.
          </p>
          <button type="button" className="text-button" onClick={() => setPolicyOpen(true)}>
            View no-show trust policy ℹ️
          </button>
          <div className="instant-board__checkin-actions">
            <button className="primary-button" type="button" disabled={busy} onClick={() => void respondCheckIn(true)}>
              Confirm I am still on
            </button>
            <button className="text-button" type="button" disabled={busy} onClick={() => void respondCheckIn(false)}>
              Cancel match
            </button>
          </div>
        </aside>
      )}

      {composeOpen ? (
        <div className="instant-sheet-overlay" role="presentation" onClick={closeCompose}>
          <aside
            className="instant-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="instant-sheet-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="instant-sheet__handle" aria-hidden="true" />
            <div className="instant-sheet__head">
              <div>
                <p className="eyebrow">Step {composeStep} of 3</p>
                <h3 id="instant-sheet-title">
                  {composeStep === 1 ? 'Do you need help today?' : composeStep === 2 ? 'Drop-off or pickup?' : 'Suburb & note'}
                </h3>
              </div>
              <button type="button" className="text-button" onClick={closeCompose}>Close</button>
            </div>

            <form className="stack-form feed-compose instant-compose" onSubmit={(event) => void submit(event)}>
              {composeStep === 1 ? (
                <div className="friendly-field" role="group" aria-label="Request type">
                  <div className="segmented-toggle" role="radiogroup" aria-label="Request type">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={intent === 'need_help'}
                      className={intent === 'need_help' ? 'segmented-toggle__btn segmented-toggle__btn--navy' : 'segmented-toggle__btn'}
                      onClick={() => { setIntent('need_help'); setComposeStep(2); }}
                    >
                      🙋‍♂️ I need help
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={intent === 'can_help'}
                      className={intent === 'can_help' ? 'segmented-toggle__btn segmented-toggle__btn--coral' : 'segmented-toggle__btn'}
                      onClick={() => { setIntent('can_help'); setComposeStep(2); }}
                    >
                      🤝 I can help
                    </button>
                  </div>
                </div>
              ) : null}

              {composeStep === 2 ? (
                <div className="friendly-field" role="group" aria-label="School run">
                  <div className="icon-tabs" role="radiogroup" aria-label="School run direction">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={direction === 'dropoff'}
                      className={direction === 'dropoff' ? 'icon-tab icon-tab--active' : 'icon-tab'}
                      onClick={() => { setDirection('dropoff'); setComposeStep(3); }}
                    >
                      <span aria-hidden="true">☀️</span>
                      Drop-off
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={direction === 'pickup'}
                      className={direction === 'pickup' ? 'icon-tab icon-tab--active' : 'icon-tab'}
                      onClick={() => { setDirection('pickup'); setComposeStep(3); }}
                    >
                      <span aria-hidden="true">🏫</span>
                      Pickup
                    </button>
                  </div>
                  <button type="button" className="text-button" onClick={() => setComposeStep(1)}>Back</button>
                </div>
              ) : null}

              {composeStep === 3 ? (
                <>
                  <div className="friendly-field" role="group" aria-label="Suburb-level area label">
                    <span className="friendly-field__label">Suburb-level area label</span>
                    {!suburbEditing && areaLabel.trim() ? (
                      <div className="suburb-autofill">
                        <span className="suburb-autofill__value">📍 {areaLabel}{/\bVIC\b/i.test(areaLabel) ? '' : ' VIC'}</span>
                        <button type="button" className="text-button" onClick={() => setSuburbEditing(true)}>Edit</button>
                      </div>
                    ) : (
                      <>
                        <input
                          required
                          maxLength={64}
                          value={areaLabel}
                          onChange={(event) => setAreaLabel(event.target.value)}
                          placeholder={registeredSuburb || 'e.g. Docklands'}
                        />
                        {registeredSuburb ? (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => {
                              setAreaLabel(registeredSuburb);
                              setSuburbEditing(false);
                            }}
                          >
                            Use registered suburb ({registeredSuburb})
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>

                  <div className="friendly-field" role="group" aria-label="Optional note">
                    <span className="friendly-field__label">Optional note</span>
                    <div className="note-chips" role="group" aria-label="Quick note presets">
                      {NOTE_CHIPS.map((chip) => (
                        <button
                          key={chip.id}
                          type="button"
                          className="note-chip"
                          onClick={() => appendNoteChip(chip.phrase)}
                        >
                          {chip.label}
                        </button>
                      ))}
                    </div>
                    <input
                      maxLength={500}
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      placeholder="Keep it brief and phone-free"
                    />
                  </div>

                  <div className="instant-sheet__actions">
                    <button type="button" className="text-button" onClick={() => setComposeStep(2)}>Back</button>
                    <button className="primary-button instant-compose__cta" type="submit" disabled={busy || !areaLabel.trim()}>
                      {busy ? 'Posting…' : 'Post to school board'}
                    </button>
                  </div>
                </>
              ) : null}
            </form>
          </aside>
        </div>
      ) : null}

      <ul className="feed-list">
        {items.length === 0 && (
          <li className="section-copy">No open instant requests for your school right now.</li>
        )}
        {items.map((item) => {
          const selected = selectedMatch?.id === item.id;
          return (
          <li
            key={item.id}
            className={selected ? 'feed-card match-card--selected' : 'feed-card'}
            data-selected={selected ? 'true' : 'false'}
            onClick={() => handleCardClick(item)}
          >
            <div className="feed-card__top">
              <ParentTrustBadge
                client={client}
                peerUserId={item.requesterId}
                displayName={item.requesterDisplayName}
                band={item.requesterParentTrustBand || item.requesterTrustBand}
                suburb={item.schoolSuburb || item.areaLabel}
              />
              <span className="feed-card__status">{statusLabelEnglish(item.status)}</span>
            </div>
            <p className="feed-card__meta">
              {intentLabelEnglish(item.intent)}
              {' · '}
              {directionLabelEnglish(item.direction)}
              {' · '}
              {item.areaLabel}
            </p>
            <small className="feed-card__byline">
              {item.targetDate}
              {item.pickupAt ? ` · pickup ${formatClock(item.pickupAt)}` : ''}
              {item.notes ? ` · ${item.notes}` : ''}
              {item.status === 'matched' && item.matchedDisplayName
                ? ` · matched with ${item.matchedDisplayName}`
                : ''}
            </small>
            <div className="feed-card__actions" onClick={(event) => event.stopPropagation()}>
              {!item.mine && item.status === 'open' && (
                <button
                  className="primary-button feed-card__cta"
                  type="button"
                  disabled={busy}
                  onClick={() => void requestMatch(item.id)}
                >
                  Request Match
                </button>
              )}
              {item.mine && item.status === 'open' && (
                <button className="text-button" type="button" disabled={busy} onClick={() => void cancel(item.id)}>
                  Cancel my request
                </button>
              )}
              {(item.mine || item.iAmMatched) && item.status === 'matched' && (
                <>
                  <button
                    className="primary-button feed-card__cta"
                    type="button"
                    disabled={busy || !item.chatRoomId}
                    onClick={() => void handleStartChat(item)}
                  >
                    Start chat in Messages
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={busy || !item.chatRoomId}
                    onClick={() => void openMatchedChat(item.id, true)}
                  >
                    Quick chat drawer
                  </button>
                </>
              )}
            </div>
          </li>
          );
        })}
      </ul>

      {selectedMatch ? (
        <div
          className="match-detail-modal-overlay"
          role="presentation"
          onClick={() => setSelectedMatch(null)}
        >
          <div
            className="match-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="match-detail-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="match-detail-modal__head">
              <h3 id="match-detail-title">Pickup Match Details</h3>
              <button
                type="button"
                className="text-button"
                onClick={() => setSelectedMatch(null)}
              >
                Close
              </button>
            </div>
            <p>
              <strong>Intent:</strong>{' '}
              {intentLabelEnglish(selectedMatch.intent)}
              {' · '}
              {directionLabelEnglish(selectedMatch.direction)}
            </p>
            <p>
              <strong>Date &amp; Time:</strong>{' '}
              {selectedMatch.targetDate}
              {selectedMatch.pickupAt
                ? ` · pickup ${formatClock(selectedMatch.pickupAt)}`
                : ''}
            </p>
            <p>
              <strong>Notes:</strong>{' '}
              {selectedMatch.notes?.trim() || 'No additional description provided.'}
            </p>
            <p>
              <strong>Area:</strong>{' '}
              {selectedMatch.areaLabel || selectedMatch.schoolSuburb || 'Local suburb'}
            </p>
            <p>
              <strong>Status:</strong> {statusLabelEnglish(selectedMatch.status)}
            </p>

            {(selectedMatch.mine || selectedMatch.iAmMatched) && selectedMatch.status === 'matched' ? (
              <button
                type="button"
                className="primary-button btn-primary-chat"
                disabled={busy || !selectedMatch.chatRoomId}
                onClick={() => void handleStartChat(selectedMatch)}
              >
                {busy ? 'Opening chat…' : 'Start 1:1 Chat with Partner'}
              </button>
            ) : null}

            {!selectedMatch.chatRoomId && selectedMatch.status === 'matched' ? (
              <p className="field-help" role="status">Chat room is not ready yet.</p>
            ) : null}

            <button
              type="button"
              className="text-button"
              onClick={() => setSelectedMatch(null)}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}

      {matchRoom && resolvedUserId ? (
        <MatchChatDrawer
          client={client}
          userId={resolvedUserId}
          room={matchRoom}
          onClose={() => setMatchRoom(null)}
          onToast={(text) => {
            setToast(text);
            window.setTimeout(() => setToast(null), 3200);
          }}
        />
      ) : null}
    </section>
  );
}

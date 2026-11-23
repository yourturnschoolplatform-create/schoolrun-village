import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  directionLabelEnglish,
  intentLabelEnglish,
  statusLabelEnglish,
} from '../../shared/au-location';
import { type SchoolRunDirection, type ScheduleIntent } from '../../shared/schedules';
import { scheduleApi, type ScheduleOverview } from '../lib/schedule-api';
import { chatApi, type ChatRoom } from '../lib/chat-api';
import {
  applyUnreadDocumentTitle,
  subscribeChatInboxAlerts,
  type InboxToast,
} from '../lib/chat-inbox-alerts';
import { armInboxAlertAudio, cueInboxAlert } from '../lib/inbox-alert-cue';
import { ChatHub } from './ChatHub';
import { ListingChatOverlay } from './ListingChatOverlay';
import { CommunityHub } from './CommunityHub';
import { InstantPickupBoard } from './InstantPickupBoard';
import { MatchHub } from './MatchHub';
import { PushEnableBanner } from './PushEnableBanner';
import { ParentDiscussionsPreview } from './ParentDiscussionsPreview';
import { QuickActions, type QuickActionFocus } from './QuickActions';
import { normalizeScheduleNavView, ScheduleNav, type ScheduleNavView } from './ScheduleNav';
import type { CommunityPanel } from './CommunityHub';

type ViewMode = ScheduleNavView;

function schoolLocalDate(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (kind: string) => parts.find((item) => item.type === kind)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function displayDate(date: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: timezone }).format(new Date(`${date}T12:00:00Z`));
}

function intentLabel(intent: ScheduleIntent): string {
  return intentLabelEnglish(intent);
}

function directionLabel(direction: SchoolRunDirection): string {
  return directionLabelEnglish(direction);
}

export function ScheduleHub({
  client,
  userId,
  onModeration,
  onAdminConsole = null,
}: {
  client: SupabaseClient;
  userId: string;
  onModeration: (() => void) | null;
  onAdminConsole?: (() => void) | null;
}) {
  const [view, setView] = useState<ViewMode>('today');
  const [activeChatRoom, setActiveChatRoom] = useState<ChatRoom | null>(null);
  const [listingChatRoom, setListingChatRoom] = useState<ChatRoom | null>(null);
  const [viewingRoomId, setViewingRoomId] = useState<string | null>(null);
  const [messagesUnread, setMessagesUnread] = useState(0);
  const [inboxToast, setInboxToast] = useState<InboxToast | null>(null);
  const viewRef = useRef<ViewMode>('today');
  const viewingRoomIdRef = useRef<string | null>(null);
  const matchOverlayRoomIdRef = useRef<string | null>(null);
  const [overview, setOverview] = useState<ScheduleOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [newHouseholdCode, setNewHouseholdCode] = useState<string | null>(null);
  const [householdCodeInput, setHouseholdCodeInput] = useState('');
  const [communityPanel, setCommunityPanel] = useState<CommunityPanel>('market');
  const [discussionThreadId, setDiscussionThreadId] = useState<string | null>(null);
  const [discussionPostId, setDiscussionPostId] = useState<string | null>(null);
  const [marketplaceListingId, setMarketplaceListingId] = useState<string | null>(null);
  const [householdOpen, setHouseholdOpen] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [pickupComposeOpen, setPickupComposeOpen] = useState(false);
  const [pickupPresetIntent, setPickupPresetIntent] = useState<ScheduleIntent | null>(null);
  const fallbackStart = useMemo(() => schoolLocalDate(), []);
  const start = overview?.start ?? fallbackStart;
  const timezone = overview?.timezone ?? 'Australia/Melbourne';
  const registeredSuburb = (overview?.schoolSuburb ?? '').trim();

  function openPickupCompose(intent: ScheduleIntent) {
    setPickupPresetIntent(intent);
    setPickupComposeOpen(true);
    setView('today');
  }

  function selectView(next: ViewMode | string) {
    const resolved = normalizeScheduleNavView(next);
    setView(resolved);
    viewRef.current = resolved;
    setListingChatRoom(null);
    if (resolved !== 'messages') {
      setActiveChatRoom(null);
      setViewingRoomId(null);
      viewingRoomIdRef.current = null;
    }
  }

  function openChatRoom(room: ChatRoom, options?: { forceMessages?: boolean }) {
    setInboxToast(null);
    setViewingRoomId(room.id);
    viewingRoomIdRef.current = room.id;

    // Marketplace Chat 1:1 — open as Karrot-style overlay (keep Market context).
    if (room.schedule.pinKind === 'marketplace' && !options?.forceMessages) {
      setListingChatRoom(room);
      return;
    }

    setListingChatRoom(null);
    setActiveChatRoom(room);
    setView('messages');
    viewRef.current = 'messages';
  }

  function closeListingChat() {
    setListingChatRoom(null);
    setViewingRoomId(null);
    viewingRoomIdRef.current = null;
  }

  function openListingChatInMessages() {
    if (!listingChatRoom) return;
    const room = listingChatRoom;
    setListingChatRoom(null);
    openChatRoom(room, { forceMessages: true });
  }

  /** Open a specific room from push / in-app banner (always land in Messages 1:1). */
  async function openChatById(roomId: string, options?: { forceMessages?: boolean }) {
    try {
      const rooms = await chatApi.listRooms(client);
      const match = rooms.find((room) => room.id === roomId);
      if (match) {
        openChatRoom(match, { forceMessages: options?.forceMessages !== false });
        return;
      }
    } catch {
      /* fall through */
    }
    selectView('messages');
  }

  function openDiscussions(threadId?: string | null) {
    setCommunityPanel('discussions');
    setDiscussionThreadId(threadId && /^[0-9a-f-]{36}$/i.test(threadId) ? threadId : null);
    selectView('community');
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      document.getElementById('community-discussions-title')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function selectQuickAction(next: ViewMode, focus?: QuickActionFocus) {
    const panelByFocus: Partial<Record<QuickActionFocus, CommunityPanel>> = {
      market: 'market',
      trust: 'trust',
      relay: 'relay',
      deals: 'deals',
      discussions: 'discussions',
      instant: 'pickup',
    };
    if (focus && panelByFocus[focus] && next === 'community') {
      setCommunityPanel(panelByFocus[focus]!);
    } else if (focus === 'deals') {
      setCommunityPanel('deals');
    } else if (focus === 'market') {
      setCommunityPanel('market');
    } else if (focus === 'relay') {
      setCommunityPanel('relay');
    } else if (focus === 'trust') {
      setCommunityPanel('trust');
    } else if (focus === 'discussions') {
      setCommunityPanel('discussions');
      setDiscussionThreadId(null);
    }
    if (focus === 'instant') {
      openPickupCompose('need_help');
    } else {
      selectView(next);
    }
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      const target = focus === 'instant'
        ? document.getElementById('instant-board-title')
        : focus === 'deals'
          ? document.getElementById('hot-deals-title')
          : focus === 'trust'
            ? document.getElementById('parent-trust-title')
            : focus === 'discussions'
              ? document.getElementById('community-discussions-title')
              : focus === 'market' || focus === 'relay'
                ? document.getElementById('marketplace-title')
                : null;
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  const refresh = useCallback(async () => {
    try {
      const data = await scheduleApi.overview(client);
      setOverview(data);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Your schedule could not be loaded.');
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    viewingRoomIdRef.current = viewingRoomId;
  }, [viewingRoomId]);

  useEffect(() => armInboxAlertAudio(), []);

  useEffect(() => {
    const stop = subscribeChatInboxAlerts(client, userId, {
      onUnreadTotal: setMessagesUnread,
      onToast: (toast) => {
        setInboxToast(toast);
        cueInboxAlert();
        window.setTimeout(() => {
          setInboxToast((current) => (current?.id === toast.id ? null : current));
        }, 5000);
      },
      getActiveRoomId: () => viewingRoomIdRef.current || matchOverlayRoomIdRef.current,
    });
    return stop;
  }, [client, userId]);

  useEffect(() => {
    applyUnreadDocumentTitle(messagesUnread);
  }, [messagesUnread]);

  // Deep link from Web Push / Share:
  // /?view=messages&openChat=<id>
  // /?view=community&panel=discussions&thread=<id>
  // /?view=community&panel=market&listing=<id>
  // Legacy ?view=calendar redirects cleanly to Today.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    const openChat = params.get('openChat') || params.get('room');
    const nextView = params.get('view');
    const panel = params.get('panel');
    const thread = params.get('thread');
    const post = params.get('post');
    const listing = params.get('listing');
    const wantsMessages = path === '/messages' || nextView === 'messages';

    if (openChat && /^[0-9a-f-]{36}$/i.test(openChat)) {
      void openChatById(openChat);
    } else if (nextView === 'community' || panel === 'discussions' || panel === 'market' || listing) {
      if (panel === 'discussions' || panel === 'market' || panel === 'pickup'
        || panel === 'trust' || panel === 'relay' || panel === 'deals') {
        setCommunityPanel(panel);
      } else if (listing) {
        setCommunityPanel('market');
      } else {
        setCommunityPanel('discussions');
      }
      if (thread && /^[0-9a-f-]{36}$/i.test(thread)) {
        setDiscussionThreadId(thread);
        setCommunityPanel('discussions');
      }
      if (post && /^[0-9a-f-]{36}$/i.test(post)) {
        setDiscussionPostId(post);
      }
      if (listing && /^[0-9a-f-]{36}$/i.test(listing)) {
        setMarketplaceListingId(listing);
        setCommunityPanel('market');
      }
      selectView('community');
    } else if (wantsMessages) {
      selectView('messages');
    } else if (nextView) {
      selectView(normalizeScheduleNavView(nextView));
    } else {
      return;
    }

    params.delete('openChat');
    params.delete('room');
    params.delete('view');
    params.delete('chatKind');
    params.delete('panel');
    params.delete('thread');
    params.delete('post');
    params.delete('listing');
    const qs = params.toString();
    const next = `/${qs ? `?${qs}` : ''}${window.location.hash}`;
    window.history.replaceState({}, document.title, next || '/');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- boot deep-link once
  }, [client]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        url?: string;
        roomId?: string | null;
        openChat?: string | null;
      } | null;
      if (!data || data.type !== 'open-chat') return;

      const directRoom = typeof data.roomId === 'string' && data.roomId
        ? data.roomId
        : (typeof data.openChat === 'string' ? data.openChat : null);
      if (directRoom && /^[0-9a-f-]{36}$/i.test(directRoom)) {
        setInboxToast(null);
        void openChatById(directRoom, { forceMessages: true });
        return;
      }

      if (typeof data.url !== 'string') {
        selectView('messages');
        return;
      }
      try {
        const target = new URL(data.url, window.location.origin);
        const roomId = target.searchParams.get('openChat') || target.searchParams.get('room');
        if (roomId && /^[0-9a-f-]{36}$/i.test(roomId)) {
          setInboxToast(null);
          void openChatById(roomId, { forceMessages: true });
        } else {
          selectView('messages');
        }
      } catch {
        selectView('messages');
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const todayInstances = overview?.instances.filter((instance) => instance.service_date === start) ?? [];

  async function cancelInstance(instanceId: string) {
    setBusy(true);
    try {
      await scheduleApi.cancelInstance(client, instanceId);
      await refresh();
      setMessage('That one dated instance was cancelled. A cancellation event is ready for the later trust engine.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That instance could not be cancelled.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmHousehold(linkId: string) {
    setBusy(true);
    try {
      await scheduleApi.confirmHousehold(client, linkId);
      await refresh();
      setMessage('Household link confirmed. Future matching will exclude this household pair.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That household link could not be confirmed.');
    } finally {
      setBusy(false);
    }
  }

  async function createHouseholdCode() {
    setBusy(true);
    try {
      const result = await scheduleApi.createHouseholdCode(client);
      setNewHouseholdCode(result.code);
      setCodeCopied(false);
      setMessage('Share this one-time household confirmation code privately. It expires in seven days.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'A household confirmation code could not be created.');
    } finally {
      setBusy(false);
    }
  }

  async function copyHouseholdCode() {
    if (!newHouseholdCode) return;
    try {
      await navigator.clipboard.writeText(newHouseholdCode);
      setCodeCopied(true);
      setMessage('Confirmation code copied.');
      window.setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      setMessage('Could not copy automatically — select the code and copy manually.');
    }
  }

  async function claimHouseholdCode() {
    if (householdCodeInput.trim().length !== 48) {
      setMessage('Enter the complete household confirmation code.');
      return;
    }
    setBusy(true);
    try {
      await scheduleApi.claimHouseholdCode(client, householdCodeInput.trim());
      setHouseholdCodeInput('');
      await refresh();
      setMessage('Household link confirmed. Future matching will exclude this household pair.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That household confirmation code is unavailable.');
    } finally {
      setBusy(false);
    }
  }

  async function exportIcs() {
    setBusy(true);
    try {
      const file = await scheduleApi.confirmedTripsIcs(client);
      const url = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'yourturn-confirmed-trips.ics';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setMessage('Your confirmed-trip calendar was exported. It contains no unconfirmed listings.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The calendar could not be exported.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="schedule-shell min-w-0 overflow-x-hidden" aria-labelledby="schedule-title" data-schedule-hub="ready">
      <QuickActions onSelect={selectQuickAction} />
      {/* Locked 4-tab primary navigation (Calendar removed). */}
      <ScheduleNav view={view} onSelect={selectView} messagesUnread={messagesUnread} />
      <PushEnableBanner client={client} />
      {view === 'today' ? (
        <button className="text-button schedule-nav__export" type="button" onClick={() => void exportIcs()} disabled={busy}>
          Export confirmed trips (.ics)
        </button>
      ) : null}

      {inboxToast && typeof document !== 'undefined'
        ? createPortal(
          <div className="inbox-toast-layer" role="status" aria-live="polite">
            <button
              type="button"
              className="inbox-toast"
              onClick={() => {
                const roomId = inboxToast.roomId;
                setInboxToast(null);
                if (roomId) void openChatById(roomId, { forceMessages: true });
                else selectView('messages');
              }}
            >
              <span className="inbox-toast__eyebrow">
                {inboxToast.kind === 'match' ? 'Pickup match' : 'New message'}
              </span>
              <strong>{inboxToast.title}</strong>
              {inboxToast.context ? (
                <span className="inbox-toast__context">{inboxToast.context}</span>
              ) : null}
              <span className="inbox-toast__body">{inboxToast.body}</span>
            </button>
            <button
              type="button"
              className="inbox-toast__dismiss"
              aria-label="Dismiss notification"
              onClick={() => setInboxToast(null)}
            >
              ×
            </button>
          </div>,
          document.body,
        )
        : null}

      {view === 'today' ? (
        <div className="schedule-hero schedule-hero--home min-w-0 max-w-full w-full overflow-x-hidden">
          <p className="eyebrow">{registeredSuburb ? `${registeredSuburb} VIC` : 'SchoolRun Village'}</p>
          <h1 id="schedule-title">Need a pickup today, or can you help?</h1>
          <p>One clear action — ask for help or offer a seat. Suburb only, phone-free.</p>
          <div className="home-hero-actions min-w-0 max-w-full w-full" role="group" aria-label="Today actions">
            <button
              type="button"
              className="home-hero-cta home-hero-cta--ask min-w-0 max-w-full w-full"
              onClick={() => openPickupCompose('need_help')}
            >
              <span className="home-hero-cta__title">Ask for a ride</span>
              <span className="home-hero-cta__sub">I need help</span>
            </button>
            <button
              type="button"
              className="home-hero-cta home-hero-cta--offer min-w-0 max-w-full w-full"
              onClick={() => openPickupCompose('can_help')}
            >
              <span className="home-hero-cta__title">Offer a seat</span>
              <span className="home-hero-cta__sub">I can help</span>
            </button>
          </div>
        </div>
      ) : (
        <h1 id="schedule-title" className="visually-hidden">SchoolRun Village</h1>
      )}

      {view === 'messages' ? (
        <ChatHub
          client={client}
          userId={userId}
          initialRoom={activeChatRoom}
          onBack={() => selectView('today')}
          onActiveRoomChange={(roomId) => {
            setViewingRoomId(roomId);
            viewingRoomIdRef.current = roomId;
          }}
          onUnreadChange={setMessagesUnread}
        />
      ) : null}
      {view === 'community' ? (
        <CommunityHub
          client={client}
          userId={userId}
          initialPanel={communityPanel}
          initialThreadId={discussionThreadId}
          initialPostId={discussionPostId}
          initialListingId={marketplaceListingId}
          viewerSuburb={registeredSuburb || null}
          onBack={() => selectView('today')}
          onOpenChat={openChatRoom}
        />
      ) : null}
      {view === 'matches' ? <MatchHub client={client} onOpenChat={openChatRoom} /> : null}

      {view === 'today' ? (
        <div className="today-panel min-w-0 max-w-full w-full overflow-x-hidden">
          {message && <p className="notice notice--teal" role="status">{message}</p>}
          {!overview && !message && <p className="section-copy">Loading your protected schedule…</p>}
          <section className="day-view day-view--summary min-w-0 max-w-full w-full overflow-x-hidden" aria-labelledby="today-title">
            <div className="min-w-0 max-w-full">
              <p className="eyebrow">{displayDate(start, timezone)}</p>
              <h2 id="today-title">Today’s schedule</h2>
            </div>
            {todayInstances.length ? (
              <ul className="instance-list min-w-0 max-w-full w-full">
                {todayInstances.map((instance) => (
                  <li key={instance.id} className="min-w-0 max-w-full">
                    <span className="instance-list__time">{instance.window_start.slice(0, 5)}–{instance.window_end.slice(0, 5)}</span>
                    <div className="instance-list__body min-w-0 max-w-full">
                      <strong>{intentLabel(instance.intent)} · {directionLabel(instance.direction)}</strong>
                      <span>{instance.area_label} · {instance.capacity} seat{instance.capacity === 1 ? '' : 's'}</span>
                    </div>
                    <span className={instance.status === 'cancelled' ? 'instance-status instance-status--cancelled' : 'instance-status'}>{statusLabelEnglish(instance.status)}</span>
                    {instance.status === 'open' && (
                      <button className="text-button" disabled={busy} onClick={() => void cancelInstance(instance.id)}>Cancel this date</button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="section-copy">No active pickup listing for today. Use Ask or Offer above to post Instant Pickup help.</p>
            )}
          </section>
          <InstantPickupBoard
            client={client}
            userId={userId}
            defaultSuburb={registeredSuburb}
            defaultSchoolName={(overview?.schoolDisplayName ?? '').trim() || undefined}
            onOpenChat={openChatRoom}
            onActiveMatchRoomChange={(roomId) => {
              matchOverlayRoomIdRef.current = roomId;
            }}
            composeOpen={pickupComposeOpen}
            onComposeOpenChange={setPickupComposeOpen}
            presetIntent={pickupPresetIntent}
          />
          <ParentDiscussionsPreview
            client={client}
            onBrowse={() => openDiscussions(null)}
            onOpenThread={(threadId) => openDiscussions(threadId)}
          />
          <aside className="pattern-panel pattern-panel--friendly" aria-label="Household and admin">
            <div className="household-code household-code--compact">
              <button
                type="button"
                className="household-code__trigger"
                aria-expanded={householdOpen}
                onClick={() => setHouseholdOpen((open) => !open)}
              >
                🔒 Share Private Confirmation Code
                <span aria-hidden="true">{householdOpen ? '▾' : '▸'}</span>
              </button>
              {householdOpen ? (
                <div className="household-code__panel">
                  <p className="field-help">
                    A confirmed household is excluded from matching. Share a one-time code privately — no profile search, address or school data is exposed.
                  </p>
                  <button className="secondary-button" type="button" disabled={busy} onClick={() => void createHouseholdCode()}>
                    Create household confirmation code
                  </button>
                  {newHouseholdCode ? (
                    <div className="household-code__copy-row">
                      <label>
                        Your one-time code
                        <input readOnly aria-label="Your household confirmation code" value={newHouseholdCode} onFocus={(event) => event.currentTarget.select()} />
                      </label>
                      <button
                        type="button"
                        className={codeCopied ? 'household-code__copy household-code__copy--done' : 'household-code__copy'}
                        onClick={() => void copyHouseholdCode()}
                      >
                        {codeCopied ? '✅ Copied!' : '📋 Copy'}
                      </button>
                    </div>
                  ) : null}
                  <label>
                    Enter a household confirmation code
                    <input
                      aria-label="Household confirmation code"
                      value={householdCodeInput}
                      maxLength={48}
                      onChange={(event) => setHouseholdCodeInput(event.target.value)}
                      placeholder="Paste a code shared privately"
                    />
                  </label>
                  <button
                    className="text-button"
                    type="button"
                    disabled={busy || householdCodeInput.trim().length !== 48}
                    onClick={() => void claimHouseholdCode()}
                  >
                    Confirm household code
                  </button>
                </div>
              ) : null}
            </div>
            {overview?.householdLinks.filter((link) => link.status === 'pending' && link.requested_by !== userId).map((link) => (
              <button className="secondary-button" key={link.id} disabled={busy} onClick={() => void confirmHousehold(link.id)}>
                Confirm household link
              </button>
            ))}
            {onModeration && <button className="text-button" type="button" onClick={onModeration}>Open moderator review</button>}
            {onAdminConsole && <button className="text-button" type="button" onClick={onAdminConsole}>Open admin console</button>}
          </aside>
        </div>
      ) : null}

      {listingChatRoom ? (
        <ListingChatOverlay
          client={client}
          userId={userId}
          room={listingChatRoom}
          onClose={closeListingChat}
          onOpenInMessages={openListingChatInMessages}
        />
      ) : null}
    </section>
  );
}

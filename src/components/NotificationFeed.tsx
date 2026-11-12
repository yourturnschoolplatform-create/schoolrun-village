import { useEffect, useId, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChatRoom } from '../lib/chat-api';
import {
  instantPickupApi,
  type InstantPickupRequest,
} from '../lib/instant-pickup-api';
import { notificationsApi, type InboxNotification } from '../lib/notifications-api';

const NOTIFICATION_FETCH_TIMEOUT_MS = 5_000;
const MATCH_NOTICE_PREFIX = 'match-notice-';

function isSyntheticMatchNotice(id: string): boolean {
  return id.startsWith(MATCH_NOTICE_PREFIX);
}

/** When the inbox table is empty, surface matched pickup rows as notice cards. */
function matchedPickupAsNotifications(
  requests: InstantPickupRequest[],
): InboxNotification[] {
  return requests
    .filter((req) => req.status === 'matched' && (req.mine || req.iAmMatched))
    .map((req) => {
      const label = (req.notes?.trim() || req.areaLabel || req.intent || 'Match').slice(0, 80);
      return {
        id: `${MATCH_NOTICE_PREFIX}${req.id}`,
        title: 'Pickup matched',
        body: `Your pickup request (${label}) has been successfully matched!`,
        kind: 'instant_pickup_match',
        is_read: true,
        created_at: req.createdAt || new Date().toISOString(),
      };
    });
}

async function loadMatchedPickupFallback(
  client: SupabaseClient,
): Promise<InboxNotification[]> {
  try {
    const requests = await instantPickupApi.list(client, true);
    return matchedPickupAsNotifications(requests);
  } catch (err) {
    console.warn('Matched pickup notification fallback failed:', err);
    return [];
  }
}

/**
 * Owner inbox for public.notifications via JWT API + list/mark RPCs.
 * If the inbox is empty, matched instant-pickup rows are shown as notices.
 */
export function NotificationFeed({
  client,
  onOpenChat,
}: {
  client: SupabaseClient;
  onOpenChat?: (room: ChatRoom) => void;
}) {
  const id = useId();
  const [notifications, setNotifications] = useState<InboxNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleStartChatFromNotice(notificationId: string) {
    if (!onOpenChat || !isSyntheticMatchNotice(notificationId)) return;
    const requestId = notificationId.slice(MATCH_NOTICE_PREFIX.length);
    setBusyId(notificationId);
    try {
      const room = await instantPickupApi.openChat(client, requestId);
      if (!room?.id) {
        setError('Chat room is not ready yet.');
        return;
      }
      onOpenChat(room);
      setError('');
    } catch {
      setError('Chat room is not ready yet.');
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    let isMounted = true;
    let pending = false;

    async function fetchNotifications(isInitial: boolean) {
      if (!isMounted || pending) return;
      pending = true;
      if (isInitial) {
        setLoading(true);
        setError('');
      }

      const controller = new AbortController();
      let timeoutRejectId: number | undefined;
      const timeoutId = window.setTimeout(() => {
        controller.abort();
      }, NOTIFICATION_FETCH_TIMEOUT_MS);

      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutRejectId = window.setTimeout(
            () => reject(new Error('Notification fetch timeout')),
            NOTIFICATION_FETCH_TIMEOUT_MS,
          );
        });

        const fetchPromise = notificationsApi.list(client, { signal: controller.signal });
        const result = await Promise.race([fetchPromise, timeoutPromise]);
        const notificationsData = result.notifications ?? [];

        if (!isMounted) return;

        if (!notificationsData.length) {
          const fallback = await loadMatchedPickupFallback(client);
          if (!isMounted) return;
          setNotifications(fallback);
        } else {
          setNotifications(notificationsData);
        }
        setError('');
      } catch (err) {
        if (!isMounted) return;
        console.warn('Notifications fallback triggered due to:', err);
        const fallback = await loadMatchedPickupFallback(client);
        if (!isMounted) return;
        setNotifications(fallback);
        setError('');
      } finally {
        window.clearTimeout(timeoutId);
        if (timeoutRejectId != null) window.clearTimeout(timeoutRejectId);
        pending = false;
        if (isMounted) setLoading(false);
      }
    }

    void fetchNotifications(true);
    const timer = window.setInterval(() => {
      void fetchNotifications(false);
    }, 20_000);

    return () => {
      isMounted = false;
      window.clearInterval(timer);
    };
  }, [client]);

  async function markAsRead(notificationId: string) {
    if (isSyntheticMatchNotice(notificationId)) return;
    setBusyId(notificationId);
    try {
      const result = await notificationsApi.markRead(client, notificationId);
      setNotifications((current) => current.map((item) => (
        item.id === notificationId ? result.notification : item
      )));
      setError('');
    } catch {
      setError('That notification could not be marked as read. Please try again.');
    } finally {
      setBusyId(null);
    }
  }

  async function markAllRead() {
    const hasRealUnread = notifications.some(
      (item) => !item.is_read && !isSyntheticMatchNotice(item.id),
    );
    if (!hasRealUnread) return;
    setBusyId('all');
    try {
      await notificationsApi.markAllRead(client);
      setNotifications((current) => current.map((item) => (
        item.is_read || isSyntheticMatchNotice(item.id)
          ? item
          : { ...item, is_read: true }
      )));
      setError('');
    } catch {
      setError('Notifications could not all be marked as read. Please try again.');
    } finally {
      setBusyId(null);
    }
  }

  const unreadCount = notifications.filter(
    (item) => !item.is_read && !isSyntheticMatchNotice(item.id),
  ).length;

  return (
    <section className="pattern-panel" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Notifications</h2>
      {unreadCount > 0 && (
        <button
          className="text-button"
          type="button"
          disabled={busyId !== null}
          onClick={() => { void markAllRead(); }}
        >
          Mark all read
        </button>
      )}
      <p className="field-help">In-app updates refresh every 20 seconds while Matches is open.</p>
      {error && <p className="notice notice--amber" role="status">{error}</p>}
      {loading ? (
        <p className="section-copy" role="status">Loading notifications…</p>
      ) : notifications.length ? (
        <ul className="pattern-list">
          {notifications.map((item) => (
            <li className="pattern-card" key={item.id} data-read={item.is_read ? 'true' : 'false'}>
              <span>
                <strong>{item.title}</strong>
                <time dateTime={item.created_at}>
                  {new Date(item.created_at).toLocaleString('en-AU')}
                </time>
              </span>
              <p className="section-copy">{item.body}</p>
              {isSyntheticMatchNotice(item.id) && onOpenChat ? (
                <button
                  className="primary-button feed-card__cta"
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => { void handleStartChatFromNotice(item.id); }}
                >
                  {busyId === item.id ? 'Opening…' : 'Start chat in Messages'}
                </button>
              ) : null}
              {!item.is_read && !isSyntheticMatchNotice(item.id) && (
                <button
                  className="text-button"
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => { void markAsRead(item.id); }}
                >
                  {busyId === item.id ? 'Saving…' : 'Mark as read'}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="section-copy">No notifications yet.</p>
      )}
    </section>
  );
}

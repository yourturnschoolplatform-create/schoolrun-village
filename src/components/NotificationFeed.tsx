import { useEffect, useId, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { notificationsApi, type InboxNotification } from '../lib/notifications-api';

const NOTIFICATION_FETCH_TIMEOUT_MS = 5_000;

/**
 * Owner inbox for public.notifications via JWT API + list/mark RPCs.
 * Polls while open. A 5s timeout forces empty-array fallback so the UI
 * never sticks on “Loading notifications…”.
 */
export function NotificationFeed({ client }: { client: SupabaseClient }) {
  const id = useId();
  const [notifications, setNotifications] = useState<InboxNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

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

        if (isMounted) {
          setNotifications(result.notifications ?? []);
          setError('');
        }
      } catch (err) {
        if (!isMounted) return;
        console.warn('Notifications fallback triggered due to:', err);
        // Initial load: empty inbox. Polls keep the last good list.
        if (isInitial) setNotifications([]);
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
    setBusyId('all');
    try {
      await notificationsApi.markAllRead(client);
      setNotifications((current) => current.map((item) => (
        item.is_read ? item : { ...item, is_read: true }
      )));
      setError('');
    } catch {
      setError('Notifications could not all be marked as read. Please try again.');
    } finally {
      setBusyId(null);
    }
  }

  const unreadCount = notifications.filter((item) => !item.is_read).length;

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
              {!item.is_read && (
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

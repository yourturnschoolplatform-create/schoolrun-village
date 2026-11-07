import { useEffect, useId, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { notificationsApi, type InboxNotification } from '../lib/notifications-api';

/**
 * Owner inbox for public.notifications via JWT API + list/mark RPCs.
 * Polls while open (same cadence as contact notifications). Direct table
 * UPDATE is avoided because read_at must be set by mark_notification_read.
 */
export function NotificationFeed({ client }: { client: SupabaseClient }) {
  const id = useId();
  const [notifications, setNotifications] = useState<InboxNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let pending = false;
    const controller = new AbortController();
    setLoading(true);
    setError('');

    async function refresh() {
      if (!active || pending) return;
      pending = true;
      try {
        const result = await notificationsApi.list(client, { signal: controller.signal });
        if (!active) return;
        setNotifications(result.notifications);
        setError('');
        setLoading(false);
      } catch {
        if (active) {
          setError('Notifications could not be refreshed. We will try again while this page is open.');
          setLoading(false);
        }
      } finally {
        pending = false;
      }
    }

    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 20_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      controller.abort();
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

import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pushApi, resolveVapidPublicKey, type PushPermissionState } from '../lib/push-api';

const DISMISS_KEY = 'srv.pushEnableBanner.dismissed';

/**
 * Non-intrusive Karrot-style prompt when Notification.permission is still `default`.
 * Requests permission only on user gesture, then syncs the VAPID subscription.
 */
export function PushEnableBanner({
  client,
  vapidPublicKey: vapidProp = null,
}: {
  client: SupabaseClient;
  vapidPublicKey?: string | null;
}) {
  const [state, setState] = useState<PushPermissionState>('unsupported');
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [hint, setHint] = useState<string | null>(null);
  const platform = pushApi.platformNote();

  const refresh = useCallback(async () => {
    const next = await pushApi.permissionState();
    setState(next);
    // If already granted, quietly re-sync the subscription endpoint on entry.
    if (next === 'granted' || next === 'subscribed') {
      await pushApi.syncSubscription(client, vapidProp);
      setState(await pushApi.permissionState());
    }
  }, [client, vapidProp]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (dismissed) return null;
  if (state === 'unsupported' || state === 'denied' || state === 'subscribed') return null;
  if (state !== 'default' && state !== 'granted') return null;
  // `granted` without subscription still shows a light "finish setup" CTA.
  const needsGesture = state === 'default';

  async function enable() {
    setBusy(true);
    setHint(null);
    try {
      const key = await resolveVapidPublicKey(vapidProp);
      if (!key) {
        setHint('Push keys are not configured yet. In-app banners still work while the app is open.');
        return;
      }
      const ok = await pushApi.enable(client, vapidProp);
      if (!ok) {
        setHint(platform || 'Notifications were not enabled. You can try again from Messages.');
      } else {
        setHint('Message alerts are on for this device.');
        window.setTimeout(() => setDismissed(true), 1600);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function dismiss() {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  }

  return (
    <div className="push-enable-banner" role="region" aria-label="Enable message alerts">
      <div className="push-enable-banner__copy">
        <strong>{needsGesture ? 'Enable message alerts' : 'Finish setting up alerts'}</strong>
        <p>
          {needsGesture
            ? 'Get a ping when a parent messages you — opens the exact chat room.'
            : 'Allow this device to finish syncing your push subscription.'}
        </p>
        {(hint || platform) ? (
          <p className="push-enable-banner__hint" role="note">{hint || platform}</p>
        ) : null}
      </div>
      <div className="push-enable-banner__actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy}
          onClick={() => { void enable(); }}
        >
          {busy ? 'Working…' : 'Enable alerts'}
        </button>
        <button type="button" className="text-button" disabled={busy} onClick={dismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}

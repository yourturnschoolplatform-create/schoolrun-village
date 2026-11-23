import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pushApi, resolveVapidPublicKey, type PushPermissionState } from '../lib/push-api';

/**
 * Karrot-style opt-in for Web Push.
 * Uses VITE_VAPID_PUBLIC_KEY (or /api/push/vapid-public-key) + iPhone Home Screen tip.
 */
export function PushNotifyToggle({
  client,
  vapidPublicKey: vapidProp = null,
}: {
  client: SupabaseClient;
  vapidPublicKey?: string | null;
}) {
  const [state, setState] = useState<PushPermissionState>('unsupported');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [vapidReady, setVapidReady] = useState(false);
  const platform = pushApi.platformNote();

  const refresh = useCallback(async () => {
    const permission = await pushApi.permissionState();
    setState(permission);
    setNote(pushApi.platformNote());
    const key = await resolveVapidPublicKey(vapidProp);
    setVapidReady(Boolean(key));
    if (permission === 'granted' || permission === 'subscribed') {
      await pushApi.syncSubscription(client, vapidProp);
      setState(await pushApi.permissionState());
    }
  }, [client, vapidProp]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function enable() {
    if (!vapidReady) {
      setNote(
        'Set VITE_VAPID_PUBLIC_KEY (and server VAPID_PRIVATE_KEY) to enable device push. In-app banners still work when the app is open.',
      );
      return;
    }
    setBusy(true);
    try {
      const ok = await pushApi.enable(client, vapidProp);
      if (!ok) {
        setNote(
          platform
          || 'Notifications were not enabled. Check browser permission settings and try again.',
        );
      } else {
        setNote('Alerts on. You will get a ping for new messages and pickup matches.');
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      await pushApi.disable(client);
      setNote('Push alerts turned off on this device.');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const enabled = state === 'subscribed';

  return (
    <div className="push-notify" role="group" aria-label="Message alerts">
      <div className="push-notify__row">
        <div>
          <strong>Message alerts</strong>
          <p className="field-help">
            Get a ping when a parent messages you or a pickup match starts — instant chat alerts.
          </p>
        </div>
        <button
          type="button"
          className={enabled ? 'secondary-button' : 'primary-button'}
          disabled={busy || state === 'unsupported' || state === 'denied'}
          onClick={() => { void (enabled ? disable() : enable()); }}
        >
          {busy ? 'Working…' : enabled ? 'Turn off' : 'Enable alerts'}
        </button>
      </div>
      {state === 'denied' && (
        <p className="field-help">
          Notifications are blocked in this browser. Open site settings to allow them again.
        </p>
      )}
      {(note || platform) && (
        <p className="field-help push-notify__hint" role="note">
          {note || platform}
        </p>
      )}
    </div>
  );
}

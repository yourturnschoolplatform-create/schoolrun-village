import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { contactApi } from '../lib/contact-api';

const CONSENT_ACKNOWLEDGEMENT = 'Email relay is the default. Your mobile number is shared only with this swap partner and up to two chosen backups. Once you enable sharing, keeping consent is a condition of this swap. Withdrawing consent ends it immediately.';
const MEMBERSHIP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ContactSharingProps = {
  client: SupabaseClient;
  swapId: string;
  onChanged: () => Promise<void>;
};

function normaliseAustralianMobile(value: string): string | null {
  const compact = value.replace(/[\s-]/g, '');
  const international = /^04\d{8}$/.test(compact) ? `+61${compact.slice(1)}` : compact;
  return /^\+614\d{8}$/.test(international) ? international : null;
}

export function ContactSharing({ client, swapId, onChanged }: ContactSharingProps) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const generation = useRef(0);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [consentVersion, setConsentVersion] = useState<number | null>(null);

  useEffect(() => {
    generation.current += 1;
    running.current = false;
    const form = formRef.current;
    form?.reset();
    setBusy(false);
    setEnded(false);
    setMessage('');
    setError('');
    setConsentVersion(null);
    return () => {
      generation.current += 1;
      running.current = false;
      // The number lives only in the form, not React state or browser storage.
      form?.reset();
    };
  }, [client, swapId]);

  async function grant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running.current || ended) return;
    const data = new FormData(event.currentTarget);
    const mobileNumber = normaliseAustralianMobile(String(data.get('mobileNumber') ?? ''));
    const chosenBackups = ['backup1', 'backup2']
      .map((name) => String(data.get(name) ?? '').trim().toLowerCase())
      .filter(Boolean);
    setError('');
    setMessage('');
    if (!mobileNumber) {
      setError('Enter a valid Australian mobile number starting with 04 or +61 4. Spaces and hyphens are allowed.');
      return;
    }
    if (chosenBackups.some((memberId) => !MEMBERSHIP_ID.test(memberId)) || new Set(chosenBackups).size !== chosenBackups.length) {
      setError('Use a different valid membership ID for each chosen backup, or leave the optional fields empty.');
      return;
    }
    if (data.get('acknowledgement') !== 'on') {
      setError('Please explicitly acknowledge the version 1 consent policy before enabling sharing.');
      return;
    }
    const current = generation.current;
    running.current = true;
    setBusy(true);
    try {
      const result = await contactApi.grant(client, swapId, { mobileNumber, chosenBackups });
      if (generation.current !== current) return;
      formRef.current?.reset();
      setConsentVersion(result.consent.consentVersion);
      setMessage('Contact-sharing consent saved. Your mobile number is not displayed here.');
    } catch {
      if (generation.current === current) setError('Contact-sharing consent could not be saved. Please try again.');
    } finally {
      if (generation.current === current) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  async function revoke() {
    if (running.current || ended) return;
    const current = generation.current;
    running.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    formRef.current?.reset();
    try {
      await contactApi.revoke(client, swapId);
      if (generation.current !== current) return;
      formRef.current?.reset();
      setConsentVersion(null);
      setEnded(true);
      setMessage('Consent withdrawn. This swap has ended immediately.');
      try {
        await onChanged();
      } catch {
        if (generation.current === current) setError('The swap has ended. Refresh your swaps to update the list.');
      }
    } catch {
      if (generation.current === current) setError('Consent could not be withdrawn. Please try again; the swap has not been confirmed as ended.');
    } finally {
      if (generation.current === current) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <section className="pattern-panel" aria-labelledby={`${id}-title`} aria-busy={busy}>
      <h3 id={`${id}-title`}>Contact sharing for this swap</h3>
      <p className="section-copy">Choose whether to share your mobile number for this accepted swap. No public phone directory is created.</p>
      <p className="field-help">Email relay is the default policy; outbound email delivery is not configured.</p>
      {message && <p className="notice notice--teal" role="status">{message}{consentVersion !== null && <> Saved consent version: {consentVersion}.</>}</p>}
      {error && <p className="notice notice--red" role="alert">{error}</p>}
      <form ref={formRef} className="schedule-form" onSubmit={(event) => void grant(event)}>
        <label htmlFor={`${id}-mobile`}>Your Australian mobile number
          <input id={`${id}-mobile`} name="mobileNumber" type="tel" autoComplete="tel" placeholder="+61 4…" maxLength={32} required disabled={busy || ended} aria-describedby={`${id}-mobile-help`} />
        </label>
        <p id={`${id}-mobile-help`} className="field-help">Use 04 or +61 4 followed by eight digits. The field is cleared after saving.</p>
        <label htmlFor={`${id}-backup1`}>Chosen backup 1 membership ID (optional)
          <input id={`${id}-backup1`} name="backup1" type="text" autoComplete="off" spellCheck={false} maxLength={36} disabled={busy || ended} aria-describedby={`${id}-backup-help`} />
        </label>
        <label htmlFor={`${id}-backup2`}>Chosen backup 2 membership ID (optional)
          <input id={`${id}-backup2`} name="backup2" type="text" autoComplete="off" spellCheck={false} maxLength={36} disabled={busy || ended} aria-describedby={`${id}-backup-help`} />
        </label>
        <p id={`${id}-backup-help`} className="field-help">Use the membership IDs supplied by your chosen backups. This does not enrol them in departure cover.</p>
        <fieldset className="declaration-box" disabled={busy || ended}>
          <legend>Contact-sharing consent · version 1</legend>
          <label>
            <input name="acknowledgement" type="checkbox" required />
            <span>{CONSENT_ACKNOWLEDGEMENT}</span>
          </label>
        </fieldset>
        <button className="primary-button" type="submit" disabled={busy || ended}>{busy ? 'Please wait…' : 'Enable sharing with explicit consent'}</button>
      </form>
      <p className="notice notice--amber" id={`${id}-revoke-warning`}>Withdrawing consent immediately ends this swap for both participants. This is not just a change to contact preferences.</p>
      <button className="secondary-button" type="button" disabled={busy || ended} aria-describedby={`${id}-revoke-warning`} onClick={() => void revoke()}>Withdraw consent and end swap immediately</button>
    </section>
  );
}

type NotificationView = { id: string; createdAt: string; message: string };

function genericNotificationMessage(kind: string): string {
  if (kind.includes('revok') || kind.includes('cancel')) return 'A swap has ended because contact-sharing consent was withdrawn.';
  if (kind.includes('grant')) return 'Contact-sharing consent has been updated for one of your swaps.';
  return 'There is a contact-sharing update for one of your swaps.';
}

export function ContactNotifications({ client, onChanged }: { client: SupabaseClient; onChanged: () => Promise<void> }) {
  const id = useId();
  const callbackRef = useRef(onChanged);
  const seenIds = useRef(new Set<string>());
  const [notifications, setNotifications] = useState<NotificationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { callbackRef.current = onChanged; }, [onChanged]);

  useEffect(() => {
    let active = true;
    let pending = false;
    let initialised = false;
    const controller = new AbortController();
    const seen = seenIds.current;
    seen.clear();
    setNotifications([]);
    setLoading(true);
    setError('');
    async function refresh() {
      if (!active || pending) return;
      pending = true;
      try {
        const result = await contactApi.notifications(client, controller.signal);
        if (!active) return;
        const hasNewNotification = initialised && result.notifications.some((notification) => !seen.has(notification.id));
        for (const notification of result.notifications) seen.add(notification.id);
        initialised = true;
        // Render only generic copy, never raw server messages or a mobile number.
        setNotifications(result.notifications.map((notification) => ({
          id: notification.id,
          createdAt: notification.created_at,
          message: genericNotificationMessage(notification.kind),
        })));
        setError('');
        setLoading(false);
        if (hasNewNotification) {
          try {
            await callbackRef.current();
          } catch {
            if (active) setError('A swap update is available. Refresh your swaps to see it.');
          }
        }
      } catch {
        if (active) {
          setError('Contact notifications could not be refreshed. We will try again while this page is open.');
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
      seen.clear();
    };
  }, [client]);

  return (
    <section className="pattern-panel" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Contact notifications</h2>
      <p className="field-help">In-app updates refresh every 20 seconds while this view is open.</p>
      {error && <p className="notice notice--amber" role="status">{error}</p>}
      {loading ? <p className="section-copy" role="status">Loading contact updates…</p> : notifications.length ? (
        <ul className="pattern-list">
          {notifications.map((notification) => (
            <li className="pattern-card" key={notification.id}>
              <span><strong>{notification.message}</strong><time dateTime={notification.createdAt}>{new Date(notification.createdAt).toLocaleString('en-AU')}</time></span>
            </li>
          ))}
        </ul>
      ) : <p className="section-copy">No contact-sharing updates yet.</p>}
    </section>
  );
}

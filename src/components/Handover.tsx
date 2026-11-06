import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  confirmHandover,
  getHandover,
  type HandoverConfirmationKind,
  type HandoverResponse,
} from '../lib/handover-api';

export type HandoverProps = {
  client: SupabaseClient;
  swapId: string;
  onChanged?: () => Promise<void> | void;
};

type Snapshot = { client: SupabaseClient; swapId: string; data: HandoverResponse };

function schoolTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: value }).format();
    return value;
  } catch {
    return 'Australia/Melbourne';
  }
}

function formatTimestamp(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

function formatServiceDate(value: string): string {
  // A service date is a calendar date, not an instant in the browser's timezone.
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return 'School trip';
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  }).format(date);
}

export function Handover({ client, swapId, onChanged }: HandoverProps) {
  const id = useId();
  const generation = useRef(0);
  const running = useRef(false);
  const notifiedLegs = useRef(new Set<string>());
  const callbackRef = useRef(onChanged);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  // Never render a previous swap's facts while new props are being loaded.
  const handover = snapshot?.client === client && snapshot.swapId === swapId ? snapshot.data : null;
  const timeZone = schoolTimeZone(handover?.timeZone || 'Australia/Melbourne');

  useEffect(() => { callbackRef.current = onChanged; }, [onChanged]);

  const refresh = useCallback(async () => {
    if (running.current) return;
    const current = generation.current;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const data = await getHandover(client, swapId);
      if (generation.current === current) setSnapshot({ client, swapId, data });
    } catch {
      if (generation.current === current) setError('Handover could not be refreshed. Please try again.');
    } finally {
      if (generation.current === current) {
        running.current = false;
        setBusy(false);
      }
    }
  }, [client, swapId]);

  useEffect(() => {
    generation.current += 1;
    running.current = false;
    notifiedLegs.current.clear();
    setSnapshot(null);
    setPendingAction('');
    setMessage('');
    setError('');
    void refresh();
    return () => {
      generation.current += 1;
      running.current = false;
    };
  }, [refresh]);

  async function confirm(legId: string, kind: HandoverConfirmationKind) {
    const leg = handover?.legs.find((item) => item.id === legId);
    const authorised = kind === 'pickup_done' ? leg?.isProvider : leg?.isRecipient;
    if (running.current || !leg || !authorised || leg.completedAt || leg.confirmations.some((item) => item.kind === kind)) return;
    const current = generation.current;
    running.current = true;
    setBusy(true);
    setPendingAction(`${legId}:${kind}`);
    setMessage('');
    setError('');
    try {
      const { confirmation } = await confirmHandover(client, legId, kind);
      if (generation.current !== current) return;
      // A successful acknowledgement remains disabled even if the subsequent GET fails.
      setSnapshot((previous) => {
        if (!previous || previous.client !== client || previous.swapId !== swapId) return previous;
        return {
          ...previous,
          data: {
            ...previous.data,
            legs: previous.data.legs.map((item) => item.id !== legId ? item : {
              ...item,
              completedAt: confirmation.completedAt ?? item.completedAt,
              confirmations: item.confirmations.some((fact) => fact.kind === confirmation.confirmationKind)
                ? item.confirmations
                : [...item.confirmations, { kind: confirmation.confirmationKind, confirmedAt: confirmation.confirmedAt }],
            }),
          },
        };
      });
      setMessage(confirmation.completedAt
        ? 'Both confirmations are recorded. This leg is complete.'
        : 'Your confirmation is recorded. This leg completes only when both parents have confirmed.');
      try {
        const data = await getHandover(client, swapId);
        if (generation.current !== current) return;
        setSnapshot({ client, swapId, data });
      } catch {
        if (generation.current === current) setError('Your confirmation was saved, but the latest handover could not be loaded. Please refresh.');
      }
      if (generation.current === current && confirmation.completedAt && !notifiedLegs.current.has(legId)) {
        // Notify only for a completed POST result, never from a render or refresh loop.
        notifiedLegs.current.add(legId);
        try {
          await callbackRef.current?.();
        } catch {
          if (generation.current === current) setError('Handover is complete. Refresh your swaps to update the list.');
        }
      }
    } catch {
      if (generation.current === current) setError('Your confirmation could not be recorded. Please refresh and try again.');
    } finally {
      if (generation.current === current) {
        running.current = false;
        setBusy(false);
        setPendingAction('');
      }
    }
  }

  return (
    <section className="pattern-panel handover-panel" aria-labelledby={`${id}-title`} aria-busy={busy}>
      <h3 id={`${id}-title`}>Handover for this swap</h3>
      <p className="section-copy">Confirm only your part of each school trip. Either parent can confirm first. A leg is complete only after both confirmations.</p>
      <p className="field-help">Times use the school timezone ({timeZone}). Expected arrival is the end of the agreed service window, not a live arrival estimate.</p>
      <button className="secondary-button" type="button" disabled={busy} onClick={() => void refresh()}>{busy && !pendingAction ? 'Refreshing…' : 'Refresh handover'}</button>
      {message && <p className="notice notice--teal" role="status">{message}</p>}
      {error && <p className="notice notice--red" role="alert">{error}</p>}
      {!handover ? (!error && <p className="section-copy" role="status">Loading handover…</p>) : handover.legs.length === 0 ? (
        <p className="section-copy">No handover legs are available for this swap.</p>
      ) : (
        <ul className="pattern-list">
          {handover.legs.map((leg) => {
            const pickup = leg.confirmations.find((item) => item.kind === 'pickup_done');
            const arrival = leg.confirmations.find((item) => item.kind === 'child_arrived');
            const complete = Boolean(pickup && arrival && leg.completedAt);
            const oneConfirmed = Boolean(pickup) !== Boolean(arrival);
            const ownConfirmed = (leg.isProvider && Boolean(pickup)) || (leg.isRecipient && Boolean(arrival));
            const reminder = !complete && leg.reminder && !leg.reminder.resolved ? leg.reminder : null;
            return (
              <li className="match-card" key={leg.id}>
                <div>
                  <strong><time dateTime={leg.serviceDate}>{formatServiceDate(leg.serviceDate)}</time></strong>
                  <span className={`status-pill ${complete ? 'status-pill--teal' : 'status-pill--slate'}`}>{complete ? 'Complete' : 'Awaiting confirmations'}</span>
                </div>
                <p>Your role: {leg.isProvider && leg.isRecipient ? 'pickup and receiving parent' : leg.isProvider ? 'pickup parent' : leg.isRecipient ? 'receiving parent' : 'no handover action available'}.</p>
                <p>Expected arrival: {leg.expectedArrivalAt ? <time dateTime={leg.expectedArrivalAt}>{formatTimestamp(leg.expectedArrivalAt, timeZone)}</time> : 'Not available'}</p>
                <p>Pickup: {pickup ? <>recorded <time dateTime={pickup.confirmedAt}>{formatTimestamp(pickup.confirmedAt, timeZone)}</time></> : 'not yet confirmed'}.</p>
                <p>Safe arrival: {arrival ? <>recorded <time dateTime={arrival.confirmedAt}>{formatTimestamp(arrival.confirmedAt, timeZone)}</time></> : 'not yet confirmed'}.</p>
                {complete && leg.completedAt && <p>Completed <time dateTime={leg.completedAt}>{formatTimestamp(leg.completedAt, timeZone)}</time>.</p>}
                {!complete && oneConfirmed && <p className="schedule-note">{ownConfirmed ? 'Awaiting the other parent.' : 'The other parent has confirmed. Your confirmation is still needed.'} This leg is not yet complete.</p>}
                {!complete && pickup && arrival && <p className="schedule-note">Both confirmations are recorded. Refresh to check completion.</p>}
                {leg.isProvider && <button className="primary-button" type="button" disabled={busy || Boolean(pickup) || Boolean(leg.completedAt)} onClick={() => void confirm(leg.id, 'pickup_done')}>{pickup ? 'Pickup done — recorded' : pendingAction === `${leg.id}:pickup_done` ? 'Recording pickup…' : 'Pickup done'}</button>}
                {leg.isRecipient && <button className="primary-button" type="button" disabled={busy || Boolean(arrival) || Boolean(leg.completedAt)} onClick={() => void confirm(leg.id, 'child_arrived')}>{arrival ? 'Child arrived safely — recorded' : pendingAction === `${leg.id}:child_arrived` ? 'Recording safe arrival…' : 'Child arrived safely'}</button>}
                {reminder && <p className="notice notice--amber">Reminder record: {reminder.missingConfirmation === 'pickup_done' ? 'pickup confirmation' : 'safe arrival confirmation'} is still missing. Due <time dateTime={reminder.dueAt}>{formatTimestamp(reminder.dueAt, timeZone)}</time>; recorded <time dateTime={reminder.createdAt}>{formatTimestamp(reminder.createdAt, timeZone)}</time>. This is a record only; no email or external reminder has been sent.</p>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="field-help">An eligible missing-confirmation reminder is recorded after expected arrival plus 30 minutes. Reminder delivery is not yet implemented.</p>
    </section>
  );
}

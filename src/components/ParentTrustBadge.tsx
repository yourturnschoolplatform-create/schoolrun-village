import { useEffect, useId, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  parentTrustLabelForBand,
  parentTrustTone,
  type ParentTrustBandLabel,
  type ParentTrustProfile,
} from '../../shared/parent-trust';
import { parentTrustApi } from '../lib/parent-trust-api';

function ShieldMark({ tone }: { tone: string }) {
  return (
    <svg className="parent-trust-badge__mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 1.4 13.2 3.6v4.1c0 3.2-2.1 5.4-5.2 6.9C4.9 13.1 2.8 10.9 2.8 7.7V3.6L8 1.4Z"
        fill="currentColor"
        opacity={tone === 'gold' ? 0.95 : 0.88}
      />
    </svg>
  );
}

/**
 * Compact AU Parent Trust Band chip. Band labels only — never numeric scores.
 * Optional peer profile popover with verified school / pickup / relay counts.
 */
export function ParentTrustBadge({
  client,
  peerUserId,
  displayName,
  band,
  suburb,
  interactive = true,
}: {
  client?: SupabaseClient;
  peerUserId?: string | null;
  displayName: string;
  band?: string | null;
  suburb?: string | null;
  interactive?: boolean;
}) {
  const label: ParentTrustBandLabel = parentTrustLabelForBand(band);
  const tone = parentTrustTone(label);
  const panelId = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<ParentTrustProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canOpen = Boolean(interactive && client && peerUserId);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function toggle() {
    if (!canOpen || !client || !peerUserId) return;
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (profile || busy) return;
    setBusy(true);
    setError(null);
    try {
      setProfile(await parentTrustApi.getPeerProfile(client, peerUserId));
    } catch {
      setError('Trust details are available for verified same-school parents.');
    } finally {
      setBusy(false);
    }
  }

  const line = [displayName, label, suburb?.trim() || null].filter(Boolean).join(' · ');

  return (
    <span className="parent-trust" ref={rootRef}>
      <button
        type="button"
        className={`parent-trust-badge parent-trust-badge--${tone}`}
        data-parent-trust={label}
        aria-expanded={canOpen ? open : undefined}
        aria-controls={canOpen ? panelId : undefined}
        disabled={!canOpen}
        onClick={() => void toggle()}
        title={canOpen ? `View ${displayName} trust details` : label}
      >
        <ShieldMark tone={tone} />
        <span className="parent-trust-badge__text">{line}</span>
      </button>
      {open && canOpen ? (
        <div
          id={panelId}
          className="parent-trust-panel"
          role="dialog"
          aria-label={`${displayName} parent trust`}
        >
          <p className="eyebrow">Parent trust</p>
          <strong>{displayName}</strong>
          <span className={`parent-trust-badge parent-trust-badge--${tone} parent-trust-badge--static`}>
            <ShieldMark tone={tone} />
            <span className="parent-trust-badge__text">{label}</span>
          </span>
          {busy && <p className="section-copy">Loading trust details…</p>}
          {error && <p className="notice notice--amber" role="status">{error}</p>}
          {profile && !busy ? (
            <ul className="parent-trust-panel__stats">
              <li>
                <span>Verified school</span>
                <strong>{profile.verifiedSchool ? 'Yes' : 'No'}</strong>
              </li>
              <li>
                <span>Successful pickups</span>
                <strong>{profile.successfulPickups}</strong>
              </li>
              <li>
                <span>Community relay shares</span>
                <strong>{profile.communityRelayShares}</strong>
              </li>
              <li>
                <span>Suburb</span>
                <strong>{profile.schoolSuburb}</strong>
              </li>
            </ul>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

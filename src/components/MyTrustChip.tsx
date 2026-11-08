import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parentTrustLabelForBand, parentTrustTone, type ParentTrustBandLabel } from '../../shared/parent-trust';

/**
 * Compact self trust band for the ready dashboard header.
 * Uses get_my_trust band only in the label — score stays private.
 */
export function MyTrustChip({ client }: { client: SupabaseClient }) {
  const [label, setLabel] = useState<ParentTrustBandLabel>('Bronze Parent');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await client.rpc('get_my_trust');
        if (cancelled || error || !data) return;
        const row = data as { trust_band?: string };
        setLabel(parentTrustLabelForBand(row.trust_band));
      } catch {
        /* keep Bronze Parent fallback */
      }
    })();
    return () => { cancelled = true; };
  }, [client]);

  const tone = parentTrustTone(label);
  return (
    <span
      className={`my-trust-chip my-trust-chip--${tone}`}
      data-my-trust={label}
      aria-label={`Your parent trust band ${label}`}
    >
      <span className="my-trust-chip__mark" aria-hidden="true">
        <svg viewBox="0 0 16 16" focusable="false"><path d="M8 1.4 13.2 3.6v4.1c0 3.2-2.1 5.4-5.2 6.9C4.9 13.1 2.8 10.9 2.8 7.7V3.6L8 1.4Z" fill="currentColor" /></svg>
      </span>
      <span className="my-trust-chip__text">{label}</span>
    </span>
  );
}

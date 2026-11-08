import type { SupabaseClient } from '@supabase/supabase-js';
import { MyTrustChip } from './MyTrustChip';

const BANDS = [
  {
    title: 'Gold Guardian',
    copy: 'Strong verified track record on school-run handovers and community reliability.',
  },
  {
    title: 'Silver Partner',
    copy: 'Consistent pickups and relay shares with peers at your school.',
  },
  {
    title: 'Bronze Parent',
    copy: 'Starting band for newly verified parents — grow trust through completed trips.',
  },
  {
    title: 'Suspended',
    copy: 'Safety hold or admin action. Marketplace and matching stay paused until resolved.',
  },
] as const;

/**
 * Parent Trust Band & verification explainer for Community Hub.
 * Band labels only — never numeric scores.
 */
export function ParentTrustPanel({ client }: { client: SupabaseClient }) {
  return (
    <section className="feed-section parent-trust-panel-hub" aria-labelledby="parent-trust-title">
      <div className="feed-section__intro">
        <p className="eyebrow">Parent Trust</p>
        <h2 id="parent-trust-title">Trust Band &amp; verification</h2>
        <p className="section-copy">
          SchoolRun Village shows Parent Trust Bands to peers — never raw scores.
          Verified same-school parents only. No-shows on Instant Pickup can lower your band
          and may trigger school-donation notices (no in-app cash for school runs).
        </p>
      </div>

      <div className="parent-trust-panel-hub__self" aria-label="Your trust band">
        <MyTrustChip client={client} />
        <p>Your band is private-to-you in this chip and visible as a band label on your listings.</p>
      </div>

      <ul className="parent-trust-panel-hub__bands">
        {BANDS.map((band) => (
          <li key={band.title} className="parent-trust-panel-hub__band">
            <strong>{band.title}</strong>
            <p>{band.copy}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

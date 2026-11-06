import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { matchApi, type MatchCandidate, type Swap } from '../lib/match-api';
import { ContactNotifications, ContactSharing } from './ContactSharing';
import { Handover } from './Handover';

type Child = { nickname: string; yearLevel: number };

export function MatchHub({ client }: { client: SupabaseClient }) {
  const [differentDates, setDifferentDates] = useState(false);
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [swaps, setSwaps] = useState<Swap[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [children, setChildren] = useState<Record<string, Child[]>>({});

  const refresh = useCallback(async () => {
    try {
      const [candidateResult, swapResult] = await Promise.all([
        matchApi.candidates(client, differentDates), matchApi.swaps(client),
      ]);
      setCandidates(candidateResult.candidates);
      setSwaps(swapResult.swaps);
      const accepted = new Set(swapResult.swaps.filter((swap) => swap.status === 'accepted').map((swap) => swap.id));
      setChildren((current) => Object.fromEntries(Object.entries(current).filter(([id]) => accepted.has(id))));
    } catch {
      setMessage('Matches are available only after reciprocal open listings are ready.');
    }
  }, [client, differentDates]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function run(work: () => Promise<void>, success: string) {
    setBusy(true);
    try {
      await work();
      await refresh();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That swap action could not be completed.');
    } finally { setBusy(false); }
  }
  async function reveal(id: string) {
    await run(async () => {
      const result = await matchApi.children(client, id);
      setChildren((current) => ({ ...current, [id]: result.children }));
    }, 'Accepted-swap child details are visible only to participants.');
  }

  return (
    <section className="match-hub" aria-labelledby="match-title">
      <div className="schedule-hero">
        <p className="eyebrow">Reciprocal school-run swaps</p>
        <h1 id="match-title">Find a balanced school-run exchange.</h1>
        <p>Only reciprocal, same-school options appear. Trust is shown as a band, never a score.</p>
      </div>
      {message && <p className="notice notice--teal" role="status">{message}</p>}
      <ContactNotifications client={client} onChanged={refresh} />
      <label className="match-toggle">
        <input type="checkbox" checked={differentDates} onChange={(event) => setDifferentDates(event.target.checked)} />
        Include reciprocal dates within four weeks
      </label>
      <section>
        <h2>Suggested reciprocal options</h2>
        {candidates.length ? <div className="match-list">{candidates.map((candidate) => (
          <article className="match-card" key={`${candidate.viewer_need_instance_id}-${candidate.candidate_id}-${candidate.reciprocal_date}`}>
            <div><strong>{candidate.candidate_name}</strong><span className="trust-band">{candidate.trust_band}</span></div>
            <p>{candidate.area_label} · {candidate.time_overlap_minutes} min overlap</p>
            <small>Your requested trip: {candidate.first_date}; reciprocal trip: {candidate.reciprocal_date}.</small>
            <div>
              <button className="primary-button" disabled={busy} onClick={() => void run(
                () => matchApi.propose(client, candidate).then(() => undefined),
                'Proposal sent. A swap exists only if the other parent accepts.',
              )}>Propose swap</button>
              <button className="text-button" disabled={busy} onClick={() => void run(
                () => matchApi.block(client, candidate.candidate_id).then(() => undefined),
                'This parent will no longer appear in your matches.',
              )}>Block</button>
            </div>
          </article>
        ))}</div> : <p className="section-copy">No reciprocal suggestions yet. Add both help and need listings to be considered.</p>}
      </section>
      <section>
        <h2>Your swap proposals</h2>
        {swaps.length ? <div className="match-list">{swaps.map((swap) => (
          <article className="match-card" key={swap.id}>
            <div><strong>{swap.partnerName}</strong><span className="instance-status">{swap.status === 'cancelled_consent_revoked' ? 'Ended: consent withdrawn' : swap.status}</span></div>
            <p>{swap.isIncoming ? 'Incoming proposal' : 'Your proposal'} · {swap.status === 'proposed'
              ? `expires ${new Date(swap.expiresAt).toLocaleString('en-AU')}`
              : 'No contact details are shared in this summary.'}</p>
            {swap.status === 'proposed' && (swap.isIncoming ? <div>
              <button className="primary-button" disabled={busy} onClick={() => void run(
                () => matchApi.action(client, swap.id, 'accept').then(() => undefined),
                'Swap accepted. Participant-only child details are now available.',
              )}>Accept</button>
              <button className="text-button" disabled={busy} onClick={() => void run(
                () => matchApi.action(client, swap.id, 'decline').then(() => undefined), 'Proposal declined.',
              )}>Decline</button>
            </div> : <button className="text-button" disabled={busy} onClick={() => void run(
              () => matchApi.action(client, swap.id, 'withdraw').then(() => undefined), 'Proposal withdrawn.',
            )}>Withdraw</button>)}
            {swap.status === 'accepted' && <>
              <div>
                <button className="secondary-button" disabled={busy} onClick={() => void reveal(swap.id)}>Show child nickname and year level</button>
                {children[swap.id]?.map((child) => <p key={`${swap.id}-${child.nickname}`} className="child-reveal">{child.nickname} · Year {child.yearLevel}</p>)}
              </div>
              <ContactSharing client={client} swapId={swap.id} onChanged={refresh} />
              <Handover client={client} swapId={swap.id} onChanged={refresh} />
            </>}
          </article>
        ))}</div> : <p className="section-copy">No proposals yet.</p>}
      </section>
    </section>
  );
}

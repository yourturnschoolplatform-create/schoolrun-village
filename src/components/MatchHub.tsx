import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { statusLabelEnglish } from '../../shared/au-location';
import { chatApi, type ChatRoom } from '../lib/chat-api';
import { matchApi, type MatchCandidate, type Swap } from '../lib/match-api';
import { ContactNotifications, ContactSharing } from './ContactSharing';
import { Handover } from './Handover';
import { NotificationFeed } from './NotificationFeed';
import { ParentTrustBadge } from './ParentTrustBadge';

type Child = { nickname: string; yearLevel: number };

export function MatchHub({
  client,
  onOpenChat,
}: {
  client: SupabaseClient;
  onOpenChat: (room: ChatRoom) => void;
}) {
  const [differentDates, setDifferentDates] = useState(false);
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [swaps, setSwaps] = useState<Swap[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<Swap | null>(null);
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

  function handleCardClick(matchItem: Swap) {
    setSelectedMatch(matchItem);
  }

  async function openSwapChat(swapId: string) {
    setBusy(true);
    try {
      const room = await chatApi.openSwapChat(client, swapId);
      // Switch to Messages tab and open this 1:1 room (no /messages/:id router).
      onOpenChat(room);
      setMessage('');
    } catch {
      setMessage('A chat could not be opened for this swap yet.');
    } finally {
      setBusy(false);
    }
  }

  async function handleStartChat(swap: Swap) {
    setSelectedMatch(swap);
    if (swap.status !== 'accepted') {
      setMessage('Chat is available after the swap is accepted.');
      return;
    }
    await openSwapChat(swap.id);
  }

  return (
    <section className="match-hub" aria-labelledby="match-title">
      <div className="schedule-hero">
        <p className="eyebrow">Reciprocal school-run swaps</p>
        <h1 id="match-title">Find a balanced school-run exchange.</h1>
        <p>Only reciprocal, same-school options appear. Trust is shown as a band, never a score.</p>
      </div>
      {message && <p className="notice notice--teal" role="status">{message}</p>}
      <NotificationFeed client={client} onOpenChat={onOpenChat} />
      <ContactNotifications client={client} onChanged={refresh} />
      <label className="match-toggle">
        <input type="checkbox" checked={differentDates} onChange={(event) => setDifferentDates(event.target.checked)} />
        Include reciprocal dates within four weeks
      </label>
      <section>
        <h2>Suggested reciprocal options</h2>
        {candidates.length ? <div className="match-list">{candidates.map((candidate) => (
          <article className="feed-card match-card" key={`${candidate.viewer_need_instance_id}-${candidate.candidate_id}-${candidate.reciprocal_date}`}>
            <div className="feed-card__top">
              <ParentTrustBadge
                client={client}
                peerUserId={candidate.candidate_id}
                displayName={candidate.candidate_name}
                band={candidate.trust_band}
                suburb={candidate.area_label}
              />
            </div>
            <p className="feed-card__meta">{candidate.area_label} · {candidate.time_overlap_minutes} min overlap</p>
            <small className="feed-card__byline">Your requested trip: {candidate.first_date}; reciprocal trip: {candidate.reciprocal_date}.</small>
            <div className="feed-card__actions">
              <button className="primary-button feed-card__cta" disabled={busy} onClick={() => void run(
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
        {swaps.length ? <div className="match-list">{swaps.map((swap) => {
          const selected = selectedMatch?.id === swap.id;
          return (
          <article
            className={selected ? 'feed-card match-card match-card--selected' : 'feed-card match-card'}
            key={swap.id}
            data-selected={selected ? 'true' : 'false'}
            onClick={() => handleCardClick(swap)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleCardClick(swap);
              }
            }}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
          >
            <div className="feed-card__top"><strong>{swap.partnerName}</strong><span className="instance-status">{swap.status === 'cancelled_consent_revoked' ? 'Ended: consent withdrawn' : statusLabelEnglish(swap.status)}</span></div>
            <p>{swap.isIncoming ? 'Incoming proposal' : 'Your proposal'} · {swap.status === 'proposed'
              ? `expires ${new Date(swap.expiresAt).toLocaleString('en-AU')}`
              : 'No contact details are shared in this summary.'}</p>
            {swap.status === 'proposed' && (swap.isIncoming ? <div onClick={(event) => event.stopPropagation()}>
              <button className="primary-button" disabled={busy} onClick={() => void run(
                () => matchApi.action(client, swap.id, 'accept').then(() => undefined),
                'Swap accepted. Participant-only child details are now available.',
              )}>Accept</button>
              <button className="text-button" disabled={busy} onClick={() => void run(
                () => matchApi.action(client, swap.id, 'decline').then(() => undefined), 'Proposal declined.',
              )}>Decline</button>
            </div> : <button className="text-button" disabled={busy} onClick={(event) => {
              event.stopPropagation();
              void run(
                () => matchApi.action(client, swap.id, 'withdraw').then(() => undefined), 'Proposal withdrawn.',
              );
            }}>Withdraw</button>)}
            {swap.status === 'accepted' && <>
              <div className="match-card__actions" onClick={(event) => event.stopPropagation()}>
                <button className="secondary-button" disabled={busy} onClick={() => void reveal(swap.id)}>Show child nickname and year level</button>
                <button
                  className="primary-button feed-card__cta"
                  disabled={busy}
                  onClick={() => void handleStartChat(swap)}
                >
                  Start chat in Messages
                </button>
                {children[swap.id]?.map((child) => <p key={`${swap.id}-${child.nickname}`} className="child-reveal">{child.nickname} · Year {child.yearLevel}</p>)}
              </div>
              {selected ? (
                <>
                  <ContactSharing client={client} swapId={swap.id} onChanged={refresh} />
                  <Handover client={client} swapId={swap.id} onChanged={refresh} />
                </>
              ) : (
                <p className="field-help">Select this card to open contact sharing and handover details.</p>
              )}
            </>}
          </article>
          );
        })}</div> : <p className="section-copy">No proposals yet.</p>}
      </section>
    </section>
  );
}

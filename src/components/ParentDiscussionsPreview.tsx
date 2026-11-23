import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { communityApi, type CommunityThread } from '../lib/community-api';

/** Age-stage shortcuts for working parents — English only, wraps on narrow screens. */
export const DISCUSSION_AGE_STAGE_PILLS = [
  { id: 'prep', label: 'Prep & Foundation' },
  { id: 'early-primary', label: 'Years 1–2' },
  { id: 'primary', label: 'Years 3–6' },
  { id: 'high-school', label: 'High school' },
  { id: 'after-care', label: 'After-school care' },
  { id: 'wet-weather', label: 'Wet weather tips' },
] as const;

/**
 * Compact Parent Discussions entry: age-stage pills + recent school threads.
 * Deep-links into the Discussions panel or a specific thread.
 */
export function ParentDiscussionsPreview({
  client,
  onBrowse,
  onOpenThread,
  compact = false,
}: {
  client: SupabaseClient;
  onBrowse: () => void;
  onOpenThread: (threadId: string) => void;
  compact?: boolean;
}) {
  const [threads, setThreads] = useState<CommunityThread[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await communityApi.listThreads(client);
        if (!cancelled) setThreads(next.slice(0, 4));
      } catch {
        if (!cancelled) setThreads([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [client]);

  return (
    <section
      className={
        compact
          ? 'parent-discussions-preview parent-discussions-preview--compact'
          : 'parent-discussions-preview'
      }
      aria-labelledby="parent-discussions-preview-title"
    >
      <div className="parent-discussions-preview__intro">
        <div className="parent-discussions-preview__copy min-w-0">
          <p className="eyebrow">Parent Discussions</p>
          <h2 id="parent-discussions-preview-title">Age-stage tips & school threads</h2>
          <p className="section-copy">
            Jump into Prep through high-school chats, wet-weather pickup tips, and local school threads — built for busy parents.
          </p>
        </div>
        <button
          type="button"
          className="primary-button parent-discussions-preview__cta"
          onClick={onBrowse}
        >
          Browse Discussions
        </button>
      </div>

      <div
        className="parent-discussions-preview__pills"
        role="group"
        aria-label="Age-stage discussion topics"
      >
        {DISCUSSION_AGE_STAGE_PILLS.map((pill) => (
          <button
            key={pill.id}
            type="button"
            className="parent-discussions-preview__pill"
            onClick={onBrowse}
          >
            {pill.label}
          </button>
        ))}
      </div>

      {loaded && threads.length > 0 ? (
        <ul className="parent-discussions-preview__topics">
          {threads.map((thread) => (
            <li key={thread.id} className="min-w-0">
              <button
                type="button"
                className="parent-discussions-preview__topic"
                onClick={() => onOpenThread(thread.id)}
              >
                <span className="parent-discussions-preview__topic-title">{thread.title}</span>
                <span className="parent-discussions-preview__topic-meta">
                  {thread.author_display_name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : loaded ? (
        <p className="section-copy parent-discussions-preview__empty">
          No school threads yet — start one for your child’s age stage.
        </p>
      ) : (
        <p className="section-copy parent-discussions-preview__empty">Loading recent discussions…</p>
      )}
    </section>
  );
}

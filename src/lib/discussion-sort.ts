import type { CommunityThread } from './community-api';

export type DiscussionSortMode = 'recommended' | 'latest';

export const DISCUSSION_SORT_OPTIONS: Array<{ id: DiscussionSortMode; label: string }> = [
  { id: 'recommended', label: 'Recommended' },
  { id: 'latest', label: 'Latest' },
];

function toTime(value: string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

/** Most recent create / reply activity on the thread. */
export function threadLastActivityAt(thread: CommunityThread): number {
  return toTime(thread.last_activity_at || thread.created_at);
}

/**
 * Engagement score for Recommended: likes + replies (weighted),
 * with posts contributing lightly so active threads rise.
 */
export function threadEngagementScore(thread: CommunityThread): number {
  const likes = Math.max(0, thread.like_count ?? 0);
  const posts = Math.max(0, thread.post_count ?? 0);
  const comments = Math.max(0, thread.comment_count ?? 0);
  const replies = Math.max(0, posts - 1) + comments;
  return (likes * 2) + (replies * 3) + posts;
}

export function sortDiscussionThreads(
  threads: readonly CommunityThread[],
  mode: DiscussionSortMode,
): CommunityThread[] {
  const next = [...threads];
  next.sort((left, right) => {
    if (mode === 'recommended') {
      const scoreDiff = threadEngagementScore(right) - threadEngagementScore(left);
      if (scoreDiff !== 0) return scoreDiff;
    }
    const activityDiff = threadLastActivityAt(right) - threadLastActivityAt(left);
    if (activityDiff !== 0) return activityDiff;
    return left.id.localeCompare(right.id);
  });
  return next;
}

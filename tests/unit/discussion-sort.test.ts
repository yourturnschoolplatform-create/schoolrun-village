import { describe, expect, it } from 'vitest';
import type { CommunityThread } from '../../src/lib/community-api';
import {
  sortDiscussionThreads,
  threadEngagementScore,
  threadLastActivityAt,
} from '../../src/lib/discussion-sort';

function thread(partial: Partial<CommunityThread> & Pick<CommunityThread, 'id' | 'title'>): CommunityThread {
  return {
    school_id: 'school',
    author_id: 'author',
    author_display_name: 'Parent',
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    post_count: 1,
    comment_count: 0,
    like_count: 0,
    last_activity_at: partial.created_at ?? '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('discussion sort helpers', () => {
  it('scores engagement from likes, replies and posts', () => {
    expect(threadEngagementScore(thread({
      id: 'a',
      title: 'A',
      post_count: 3,
      comment_count: 2,
      like_count: 4,
    }))).toBe((4 * 2) + ((2 + 2) * 3) + 3);
  });

  it('sorts Latest by most recent activity first', () => {
    const sorted = sortDiscussionThreads([
      thread({
        id: 'old',
        title: 'Older',
        created_at: '2026-01-01T00:00:00.000Z',
        last_activity_at: '2026-01-02T00:00:00.000Z',
      }),
      thread({
        id: 'new',
        title: 'Newer',
        created_at: '2026-01-03T00:00:00.000Z',
        last_activity_at: '2026-01-04T00:00:00.000Z',
      }),
    ], 'latest');
    expect(sorted.map((entry) => entry.id)).toEqual(['new', 'old']);
  });

  it('sorts Recommended by engagement with recent activity as tie-breaker', () => {
    const quietRecent = thread({
      id: 'quiet',
      title: 'Quiet',
      like_count: 0,
      post_count: 1,
      comment_count: 0,
      created_at: '2026-01-10T00:00:00.000Z',
      last_activity_at: '2026-01-10T00:00:00.000Z',
    });
    const busyOlder = thread({
      id: 'busy',
      title: 'Busy',
      like_count: 5,
      post_count: 4,
      comment_count: 6,
      created_at: '2026-01-01T00:00:00.000Z',
      last_activity_at: '2026-01-05T00:00:00.000Z',
    });
    const busyNewer = thread({
      id: 'busy-new',
      title: 'Busy newer',
      like_count: 5,
      post_count: 4,
      comment_count: 6,
      created_at: '2026-01-02T00:00:00.000Z',
      last_activity_at: '2026-01-08T00:00:00.000Z',
    });

    const sorted = sortDiscussionThreads([quietRecent, busyOlder, busyNewer], 'recommended');
    expect(sorted.map((entry) => entry.id)).toEqual(['busy-new', 'busy', 'quiet']);
    expect(threadEngagementScore(busyNewer)).toBe(threadEngagementScore(busyOlder));
    expect(threadLastActivityAt(busyNewer)).toBeGreaterThan(threadLastActivityAt(busyOlder));
  });
});

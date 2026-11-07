import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  communityApi,
  type CommunityComment,
  type CommunityPost,
  type CommunityThread,
} from '../lib/community-api';

/**
 * School discussion community. Australian English copy. No child full names or photos.
 */
export function CommunityHub({
  client,
  onBack,
}: {
  client: SupabaseClient;
  onBack: () => void;
}) {
  const [threads, setThreads] = useState<CommunityThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [commentsByPost, setCommentsByPost] = useState<Record<string, CommunityComment[]>>({});
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState('');
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refreshThreads = useCallback(async () => {
    try {
      setThreads(await communityApi.listThreads(client));
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The community board could not be loaded.');
    }
  }, [client]);

  const refreshThread = useCallback(async (threadId: string) => {
    try {
      const nextPosts = await communityApi.listPosts(client, threadId);
      setPosts(nextPosts);
      const nextComments: Record<string, CommunityComment[]> = {};
      for (const post of nextPosts) {
        nextComments[post.id] = await communityApi.listComments(client, post.id);
      }
      setCommentsByPost(nextComments);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'This discussion could not be loaded.');
    }
  }, [client]);

  useEffect(() => { void refreshThreads(); }, [refreshThreads]);
  useEffect(() => {
    if (selectedThreadId) void refreshThread(selectedThreadId);
  }, [refreshThread, selectedThreadId]);

  async function createThread(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const created = await communityApi.createThread(client, title.trim(), body.trim());
      setTitle('');
      setBody('');
      await refreshThreads();
      setSelectedThreadId(created.thread.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Your discussion could not be created.');
    } finally {
      setBusy(false);
    }
  }

  async function addPost(event: FormEvent) {
    event.preventDefault();
    if (!selectedThreadId) return;
    setBusy(true);
    try {
      await communityApi.createPost(client, selectedThreadId, reply.trim());
      setReply('');
      await refreshThread(selectedThreadId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Your post could not be added.');
    } finally {
      setBusy(false);
    }
  }

  async function addComment(postId: string) {
    const draft = (commentDrafts[postId] ?? '').trim();
    if (!draft || !selectedThreadId) return;
    setBusy(true);
    try {
      await communityApi.createComment(client, postId, draft);
      setCommentDrafts((current) => ({ ...current, [postId]: '' }));
      await refreshThread(selectedThreadId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Your comment could not be added.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleLike(kind: 'post' | 'comment', id: string) {
    if (!selectedThreadId) return;
    setBusy(true);
    try {
      await communityApi.toggleLike(client, kind, id);
      await refreshThread(selectedThreadId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Your like could not be updated.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="onboarding-card" aria-labelledby="community-title">
      <button className="text-button" type="button" onClick={onBack}>Back to schedule</button>
      <p className="eyebrow">School community</p>
      <h1 id="community-title">Discussion board</h1>
      <p className="section-copy">
        Share practical school-run tips with verified parents at your organisation only.
        Do not post child full names, photos, mobile numbers or email addresses.
      </p>
      <p className="notice notice--teal" role="status">
        Privacy reminder: nickname and year level belong in swaps, not here. Photos are never allowed.
      </p>
      {message && <p className="notice notice--red" role="alert">{message}</p>}

      <form className="stack-form" onSubmit={createThread}>
        <label>
          Thread title
          <input
            required
            minLength={3}
            maxLength={120}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Wet-weather pickup tips"
          />
        </label>
        <label>
          Opening post
          <textarea
            required
            minLength={1}
            maxLength={2000}
            rows={4}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Write practical guidance without naming children or attaching photos."
          />
        </label>
        <button className="primary-button" type="submit" disabled={busy}>Start discussion</button>
      </form>

      <h2 className="section-heading">Your school threads</h2>
      {threads.length === 0 ? (
        <p className="section-copy">No discussions yet. Start one for your school community.</p>
      ) : (
        <ul className="queue-list">
          {threads.map((thread) => (
            <li key={thread.id}>
              <button
                className="text-button"
                type="button"
                onClick={() => setSelectedThreadId(thread.id)}
              >
                {thread.title}
              </button>
              <span>{thread.author_display_name}</span>
            </li>
          ))}
        </ul>
      )}

      {selectedThreadId && (
        <div className="stack-form">
          <h2 className="section-heading">Thread posts</h2>
          {posts.map((post) => (
            <article key={post.id} className="onboarding-card">
              <p className="eyebrow">{post.author_display_name}</p>
              <p className="section-copy">{post.body}</p>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => void toggleLike('post', post.id)}
              >
                {post.liked_by_me ? 'Unlike' : 'Like'} ({post.like_count})
              </button>
              <ul className="queue-list">
                {(commentsByPost[post.id] ?? []).map((comment) => (
                  <li key={comment.id}>
                    <span>{comment.author_display_name}: {comment.body}</span>
                    <button
                      className="text-button"
                      type="button"
                      disabled={busy}
                      onClick={() => void toggleLike('comment', comment.id)}
                    >
                      {comment.liked_by_me ? 'Unlike' : 'Like'} ({comment.like_count})
                    </button>
                  </li>
                ))}
              </ul>
              <label>
                Add a comment
                <input
                  maxLength={1000}
                  value={commentDrafts[post.id] ?? ''}
                  onChange={(event) => setCommentDrafts((current) => ({
                    ...current, [post.id]: event.target.value,
                  }))}
                  placeholder="Keep it practical and photo-free."
                />
              </label>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => void addComment(post.id)}
              >
                Comment
              </button>
            </article>
          ))}
          <form className="stack-form" onSubmit={addPost}>
            <label>
              Add another post
              <textarea
                required
                maxLength={2000}
                rows={3}
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder="Continue the discussion without photos or surnames."
              />
            </label>
            <button className="primary-button" type="submit" disabled={busy}>Post</button>
          </form>
        </div>
      )}
    </section>
  );
}

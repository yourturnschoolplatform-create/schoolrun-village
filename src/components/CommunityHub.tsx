import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { statusLabelEnglish } from '../../shared/au-location';
import {
  communityApi,
  type CommunityComment,
  type CommunityPost,
  type CommunityThread,
} from '../lib/community-api';
import { chatApi, withThreadChatSummary, type ChatRoom } from '../lib/chat-api';
import { HotDealsBoard } from './HotDealsBoard';
import { InstantPickupBoard } from './InstantPickupBoard';
import { MarketplaceBoard } from './MarketplaceBoard';
import { ParentTrustPanel } from './ParentTrustPanel';
import { PartnerHub } from './PartnerHub';

export type CommunityPanel = 'pickup' | 'market' | 'trust' | 'relay' | 'deals' | 'discussions';

const MODULE_TABS: Array<{ id: CommunityPanel; label: string }> = [
  { id: 'pickup', label: 'Instant Pickup' },
  { id: 'market', label: 'Marketplace' },
  { id: 'trust', label: 'Parent Trust' },
  { id: 'relay', label: 'Relay Share' },
  { id: 'deals', label: 'Hot Deals' },
];

/**
 * Five core SchoolRun Village modules + discussions + Partner Hub.
 * Australian English copy. No child full names in discussion posts.
 */
export function CommunityHub({
  client,
  userId,
  onBack,
  onOpenChat,
  initialPanel = 'market',
}: {
  client: SupabaseClient;
  userId: string;
  onBack: () => void;
  onOpenChat?: (room: ChatRoom) => void;
  initialPanel?: CommunityPanel;
}) {
  const [panel, setPanel] = useState<CommunityPanel>(initialPanel);
  const [partnerOpen, setPartnerOpen] = useState(false);
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

  useEffect(() => {
    setPanel(initialPanel);
  }, [initialPanel]);

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

  async function chatWithThreadAuthor(thread: CommunityThread) {
    if (thread.author_id === userId) {
      setMessage('This is your own discussion.');
      return;
    }
    if (!onOpenChat) {
      setMessage('Chat is not available right now. Try again from Messages later.');
      return;
    }
    setBusy(true);
    try {
      const room = await chatApi.openThreadChat(client, thread.id);
      onOpenChat(withThreadChatSummary(room, thread));
      setMessage(null);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Chat with that parent is not available right now.',
      );
    } finally {
      setBusy(false);
    }
  }

  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const canChatAuthor = Boolean(
    selectedThread
    && selectedThread.author_id !== userId
    && onOpenChat,
  );

  return (
    <section className="community-hub" aria-labelledby="community-title">
      <button className="text-button" type="button" onClick={onBack}>Back to Today</button>
      <div className="feed-section__intro">
        <p className="eyebrow">School community</p>
        <h1 id="community-title">Your SchoolRun Village hub</h1>
        <p className="section-copy">
          SchoolRun Village guidelines: keep chat school-scoped, be kind at the gate,
          and use in-app payment only for Sell and Hot Deals. Instant Pickup, Marketplace,
          Parent Trust, Relay Share and Hot Deals stay with verified parents at your school.
        </p>
      </div>

      <div className="community-banner-slider" aria-label="Community highlights">
        <article className="community-banner-slide">
          <strong>Marketplace</strong>
          <p>Kids secondhand and paid Sell with Parent Trust Bands visible.</p>
          <button type="button" className="commercial-cta commercial-cta--compact" onClick={() => setPanel('market')}>
            Open Marketplace
          </button>
        </article>
        <article className="community-banner-slide community-banner-slide--deals">
          <strong>Hot Deals</strong>
          <p>Group-buy exclusive AUD asks from local brands this term.</p>
          <button type="button" className="commercial-cta commercial-cta--compact" onClick={() => setPanel('deals')}>
            View Hot Deals
          </button>
        </article>
        <article className="community-banner-slide community-banner-slide--partner">
          <strong>Partner Hub</strong>
          <p>Local merchants: launch a goods deal, tutoring pack or sponsorship.</p>
          <button type="button" className="commercial-cta commercial-cta--compact" onClick={() => setPartnerOpen(true)}>
            Become a Partner
          </button>
        </article>
      </div>

      <div className="community-panel-tabs community-panel-tabs--modules" role="tablist" aria-label="Community modules">
        {MODULE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={panel === tab.id}
            className={panel === tab.id ? 'community-panel-tab community-panel-tab--active' : 'community-panel-tab'}
            data-community-panel={tab.id}
            onClick={() => setPanel(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected={panel === 'discussions'}
          className={panel === 'discussions' ? 'community-panel-tab community-panel-tab--active' : 'community-panel-tab'}
          data-community-panel="discussions"
          onClick={() => setPanel('discussions')}
        >
          Discussions
        </button>
      </div>

      {message && <p className="notice notice--red" role="alert">{message}</p>}

      {panel === 'pickup' ? (
        <InstantPickupBoard
          client={client}
          userId={userId}
          onOpenChat={onOpenChat ?? (() => undefined)}
        />
      ) : null}

      {panel === 'market' ? (
        <MarketplaceBoard client={client} userId={userId} onOpenChat={onOpenChat} boardMode="market" />
      ) : null}

      {panel === 'trust' ? (
        <ParentTrustPanel client={client} />
      ) : null}

      {panel === 'relay' ? (
        <MarketplaceBoard client={client} userId={userId} onOpenChat={onOpenChat} boardMode="relay" />
      ) : null}

      {panel === 'deals' ? (
        <HotDealsBoard onBecomePartner={() => setPartnerOpen(true)} />
      ) : null}

      {panel === 'discussions' ? (
        <section className="feed-section" aria-labelledby="community-discussions-title">
          <div className="feed-section__intro">
            <p className="eyebrow">Discussions</p>
            <h2 id="community-discussions-title">Your school threads</h2>
            <p className="section-copy">
              Do not post child full names, photos, mobile numbers or email addresses.
            </p>
          </div>
          <form className="stack-form feed-compose" onSubmit={(event) => void createThread(event)}>
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

          {threads.length === 0 ? (
            <p className="section-copy">No discussions yet. Start one for your school community.</p>
          ) : (
            <ul className="feed-list">
              {threads.map((thread) => (
                <li key={thread.id} className="feed-card">
                  <div className="feed-card__top">
                    <strong>{thread.title}</strong>
                    <span className="feed-card__status">{statusLabelEnglish(thread.status)}</span>
                  </div>
                  <small className="feed-card__byline">{thread.author_display_name}</small>
                  <div className="feed-card__actions">
                    <button
                      className="primary-button feed-card__cta"
                      type="button"
                      onClick={() => setSelectedThreadId(thread.id)}
                    >
                      Open thread
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {selectedThreadId && selectedThread ? (
            <section
              className="feed-section discussion-detail"
              aria-labelledby="thread-posts-title"
            >
              <div className="discussion-detail__head">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setSelectedThreadId(null)}
                >
                  Back to threads
                </button>
                <p className="eyebrow">Discussion</p>
                <h2 id="thread-posts-title" className="section-heading">{selectedThread.title}</h2>
                <small className="feed-card__byline">
                  {selectedThread.author_display_name}
                  {' · '}
                  {statusLabelEnglish(selectedThread.status)}
                </small>
              </div>

              <ul className="feed-list discussion-detail__posts">
                {posts.map((post) => (
                  <li key={post.id} className="feed-card">
                    <div className="feed-card__top">
                      <strong>{post.author_display_name}</strong>
                      <span className="feed-card__status">{statusLabelEnglish(post.status)}</span>
                    </div>
                    <p className="feed-card__body">{post.body}</p>
                    <div className="feed-card__actions">
                      <button
                        className="secondary-button feed-card__cta"
                        type="button"
                        disabled={busy}
                        onClick={() => void toggleLike('post', post.id)}
                      >
                        {post.liked_by_me ? 'Unlike' : 'Like'} ({post.like_count})
                      </button>
                    </div>
                    <ul className="feed-card__comments">
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
                      className="secondary-button feed-card__cta"
                      type="button"
                      disabled={busy}
                      onClick={() => void addComment(post.id)}
                    >
                      Comment
                    </button>
                  </li>
                ))}
              </ul>
              <form className="stack-form feed-compose" onSubmit={(event) => void addPost(event)}>
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

              {canChatAuthor ? (
                <div className="discussion-detail__bar">
                  <button
                    type="button"
                    className="discussion-detail__chat"
                    disabled={busy}
                    onClick={() => void chatWithThreadAuthor(selectedThread)}
                  >
                    Chat with author
                  </button>
                </div>
              ) : selectedThread.author_id === userId ? (
                <p className="field-help discussion-detail__own">This is your own discussion.</p>
              ) : null}
            </section>
          ) : null}
        </section>
      ) : null}

      <footer className="community-partner-footer">
        <button
          type="button"
          className="partner-banner-chip"
          onClick={() => setPartnerOpen(true)}
        >
          Become a Partner
        </button>
        <p>Local brands and tutoring providers can pitch school-scoped Hot Deals.</p>
      </footer>

      <PartnerHub open={partnerOpen} onClose={() => setPartnerOpen(false)} />
    </section>
  );
}

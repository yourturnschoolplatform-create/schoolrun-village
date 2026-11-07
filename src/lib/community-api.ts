import type { SupabaseClient } from '@supabase/supabase-js';

export type CommunityThread = {
  id: string;
  school_id: string;
  author_id: string;
  author_display_name: string;
  title: string;
  status: string;
  created_at: string;
};

export type CommunityPost = {
  id: string;
  school_id: string;
  thread_id: string;
  author_id: string;
  author_display_name: string;
  body: string;
  status: string;
  like_count: number;
  liked_by_me: boolean;
  created_at: string;
};

export type CommunityComment = {
  id: string;
  school_id: string;
  post_id: string;
  author_id: string;
  author_display_name: string;
  body: string;
  status: string;
  like_count: number;
  liked_by_me: boolean;
  created_at: string;
};

async function rpc<T>(client: SupabaseClient, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(error.message || 'Community request failed.');
  return data as T;
}

export const communityApi = {
  listThreads: (client: SupabaseClient) => rpc<CommunityThread[]>(client, 'list_community_threads'),
  listPosts: (client: SupabaseClient, threadId: string) =>
    rpc<CommunityPost[]>(client, 'list_community_posts', { p_thread_id: threadId }),
  listComments: (client: SupabaseClient, postId: string) =>
    rpc<CommunityComment[]>(client, 'list_community_comments', { p_post_id: postId }),
  createThread: (client: SupabaseClient, title: string, body: string) =>
    rpc<{ thread: CommunityThread; post: CommunityPost }>(client, 'create_community_thread', {
      p_title: title, p_body: body,
    }),
  createPost: (client: SupabaseClient, threadId: string, body: string) =>
    rpc<CommunityPost>(client, 'create_community_post', { p_thread_id: threadId, p_body: body }),
  createComment: (client: SupabaseClient, postId: string, body: string) =>
    rpc<CommunityComment>(client, 'create_community_comment', { p_post_id: postId, p_body: body }),
  toggleLike: (client: SupabaseClient, targetKind: 'post' | 'comment', targetId: string) =>
    rpc<{ liked: boolean; like_count: number }>(client, 'toggle_community_like', {
      p_target_kind: targetKind, p_target_id: targetId,
    }),
};

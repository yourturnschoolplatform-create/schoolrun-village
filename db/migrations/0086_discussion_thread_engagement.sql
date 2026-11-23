-- Enrich community thread JSON with engagement stats for Recommended / Latest sorting.
-- Safe to re-run: create or replace only.

create or replace function public.community_thread_json(p_thread public.community_threads)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_thread.id,
    'school_id', p_thread.school_id,
    'author_id', p_thread.author_id,
    'author_display_name', (
      select profile.display_name from public.profiles profile where profile.id = p_thread.author_id
    ),
    'title', p_thread.title,
    'status', p_thread.status,
    'created_at', p_thread.created_at,
    'post_count', (
      select count(*)::integer
      from public.community_posts post_row
      where post_row.thread_id = p_thread.id
        and post_row.status = 'active'
    ),
    'comment_count', (
      select count(*)::integer
      from public.community_comments comment_row
      inner join public.community_posts post_row
        on post_row.id = comment_row.post_id
      where post_row.thread_id = p_thread.id
        and post_row.status = 'active'
        and comment_row.status = 'active'
    ),
    'like_count', (
      select count(*)::integer
      from public.community_likes like_row
      where (
        (
          like_row.target_kind = 'post'
          and exists (
            select 1
            from public.community_posts post_row
            where post_row.id = like_row.target_id
              and post_row.thread_id = p_thread.id
              and post_row.status = 'active'
          )
        )
        or (
          like_row.target_kind = 'comment'
          and exists (
            select 1
            from public.community_comments comment_row
            inner join public.community_posts post_row
              on post_row.id = comment_row.post_id
            where comment_row.id = like_row.target_id
              and post_row.thread_id = p_thread.id
              and post_row.status = 'active'
              and comment_row.status = 'active'
          )
        )
      )
    ),
    'last_activity_at', (
      select greatest(
        p_thread.created_at,
        coalesce((
          select max(post_row.created_at)
          from public.community_posts post_row
          where post_row.thread_id = p_thread.id
            and post_row.status = 'active'
        ), p_thread.created_at),
        coalesce((
          select max(comment_row.created_at)
          from public.community_comments comment_row
          inner join public.community_posts post_row
            on post_row.id = comment_row.post_id
          where post_row.thread_id = p_thread.id
            and post_row.status = 'active'
            and comment_row.status = 'active'
        ), p_thread.created_at)
      )
    )
  );
$$;

revoke all on function public.community_thread_json(public.community_threads)
  from public, anon, authenticated;

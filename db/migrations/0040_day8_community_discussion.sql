-- Task 8.1: school-scoped discussion community (threads, posts, comments, likes).
-- Same-school verified members only. No photos, phones, emails, child full names,
-- nicknames, trust scores, amount, price, currency or live location.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.community_threads (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  author_id uuid not null references public.profiles(id) on delete restrict,
  author_membership uuid not null,
  title text not null
    check (char_length(trim(title)) between 3 and 120),
  status text not null default 'active'
    check (status in ('active', 'withdrawn')),
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (author_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict
);
create index community_threads_school_idx
  on public.community_threads (school_id, created_at desc);
create index community_threads_author_idx
  on public.community_threads (author_id, created_at desc);
alter table public.community_threads
  add constraint community_threads_id_school_key unique (id, school_id);

comment on table public.community_threads is
  'School-scoped discussion threads. Title only; no photos, phones, child nicknames, amount, price or currency.';

create table public.community_posts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  thread_id uuid not null,
  author_id uuid not null references public.profiles(id) on delete restrict,
  author_membership uuid not null,
  body text not null
    check (char_length(trim(body)) between 1 and 2000),
  status text not null default 'active'
    check (status in ('active', 'withdrawn')),
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (thread_id, school_id)
    references public.community_threads(id, school_id) on delete restrict,
  foreign key (author_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict
);
create index community_posts_thread_idx
  on public.community_posts (thread_id, created_at);
create index community_posts_school_idx
  on public.community_posts (school_id, created_at desc);
alter table public.community_posts
  add constraint community_posts_id_school_key unique (id, school_id);

comment on table public.community_posts is
  'School-scoped discussion posts. Text body only; no photo, phone, email, nickname or money fields.';

create table public.community_comments (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  post_id uuid not null,
  author_id uuid not null references public.profiles(id) on delete restrict,
  author_membership uuid not null,
  body text not null
    check (char_length(trim(body)) between 1 and 1000),
  status text not null default 'active'
    check (status in ('active', 'withdrawn')),
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (post_id, school_id)
    references public.community_posts(id, school_id) on delete restrict,
  foreign key (author_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict
);
create index community_comments_post_idx
  on public.community_comments (post_id, created_at);
create index community_comments_school_idx
  on public.community_comments (school_id, created_at desc);
alter table public.community_comments
  add constraint community_comments_id_school_key unique (id, school_id);

comment on table public.community_comments is
  'School-scoped post comments. Text only; no photos or child identifying fields.';

create table public.community_likes (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  target_kind text not null check (target_kind in ('post', 'comment')),
  target_id uuid not null,
  liked_by uuid not null references public.profiles(id) on delete restrict,
  liked_by_membership uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  unique (liked_by, target_kind, target_id),
  foreign key (liked_by_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict
);
create index community_likes_target_idx
  on public.community_likes (target_kind, target_id);
create index community_likes_school_idx
  on public.community_likes (school_id, created_at desc);

comment on table public.community_likes is
  'School-scoped likes on posts or comments. No payload beyond identity and target.';

-- ---------------------------------------------------------------------------
-- Content privacy helper
-- ---------------------------------------------------------------------------
create function public.community_text_is_allowed(p_text text)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog
as $$
declare
  normalised text;
begin
  if p_text is null then
    return false;
  end if;
  normalised := pg_catalog.lower(trim(p_text));
  if char_length(normalised) = 0 then
    return false;
  end if;
  -- Block phones, emails, URLs/photos, and explicit full-name / photo solicitations.
  if normalised ~ '\+?61[0-9 ]{8,}'
    or normalised ~ '\m04[0-9]{8}\M'
    or normalised ~ '[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}'
    or normalised ~ 'https?://'
    or normalised ~ 'www\.'
    or normalised ~ 'data:image'
    or normalised ~ '\.(jpg|jpeg|png|gif|webp|bmp|heic|svg)\M'
    or normalised ~ 'full name'
    or normalised ~ 'surname'
    or normalised ~ 'last name'
    or normalised ~ 'upload(ed)? (a )?photo'
    or normalised ~ 'attach(ed|ing)? (a )?photo'
    or normalised ~ 'photo of (my |our )?(child|son|daughter|kid)'
  then
    return false;
  end if;
  return true;
end;
$$;
revoke all on function public.community_text_is_allowed(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
create function public.guard_community_discussion()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_table_name = 'community_likes' then
    if tg_op = 'DELETE' then
      if current_setting('yourturn.community_unlike', true) = '1'
        and old.liked_by is not distinct from auth.uid() then
        return old;
      end if;
      raise exception 'community likes cannot be deleted directly' using errcode = '55000';
    end if;
    if tg_op = 'UPDATE' or tg_op = 'TRUNCATE' then
      raise exception 'community likes are append-only except unlike' using errcode = '55000';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'community discussion rows cannot be deleted' using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' then
    -- Task 8.2 may withdraw; Task 8.1 only allows insert. Block client updates.
    raise exception 'community discussion rows are immutable in Task 8.1'
      using errcode = '55000';
  end if;

  if tg_table_name = 'community_threads' then
    if not public.community_text_is_allowed(new.title) then
      raise exception 'community text must not include phones, emails, photos or child full names'
        using errcode = '22023';
    end if;
  elsif tg_table_name in ('community_posts', 'community_comments') then
    if not public.community_text_is_allowed(new.body) then
      raise exception 'community text must not include phones, emails, photos or child full names'
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_community_discussion() from public, anon, authenticated;

create trigger community_threads_guard_rows
  before insert or update or delete on public.community_threads
  for each row execute function public.guard_community_discussion();
create trigger community_threads_guard_truncate
  before truncate on public.community_threads
  for each statement execute function public.guard_community_discussion();
alter table public.community_threads enable always trigger community_threads_guard_rows;
alter table public.community_threads enable always trigger community_threads_guard_truncate;

create trigger community_posts_guard_rows
  before insert or update or delete on public.community_posts
  for each row execute function public.guard_community_discussion();
create trigger community_posts_guard_truncate
  before truncate on public.community_posts
  for each statement execute function public.guard_community_discussion();
alter table public.community_posts enable always trigger community_posts_guard_rows;
alter table public.community_posts enable always trigger community_posts_guard_truncate;

create trigger community_comments_guard_rows
  before insert or update or delete on public.community_comments
  for each row execute function public.guard_community_discussion();
create trigger community_comments_guard_truncate
  before truncate on public.community_comments
  for each statement execute function public.guard_community_discussion();
alter table public.community_comments enable always trigger community_comments_guard_rows;
alter table public.community_comments enable always trigger community_comments_guard_truncate;

create trigger community_likes_guard_rows
  before insert or update or delete on public.community_likes
  for each row execute function public.guard_community_discussion();
create trigger community_likes_guard_truncate
  before truncate on public.community_likes
  for each statement execute function public.guard_community_discussion();
alter table public.community_likes enable always trigger community_likes_guard_rows;
alter table public.community_likes enable always trigger community_likes_guard_truncate;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.community_threads enable row level security;
alter table public.community_posts enable row level security;
alter table public.community_comments enable row level security;
alter table public.community_likes enable row level security;

create policy community_threads_select on public.community_threads
  for select to authenticated using (
    public.is_admin()
    or (status = 'active' and public.is_member(school_id))
  );

create policy community_posts_select on public.community_posts
  for select to authenticated using (
    public.is_admin()
    or (status = 'active' and public.is_member(school_id))
  );

create policy community_comments_select on public.community_comments
  for select to authenticated using (
    public.is_admin()
    or (status = 'active' and public.is_member(school_id))
  );

create policy community_likes_select on public.community_likes
  for select to authenticated using (
    public.is_admin()
    or public.is_member(school_id)
  );

revoke all on table public.community_threads from public, anon, authenticated;
revoke all on table public.community_posts from public, anon, authenticated;
revoke all on table public.community_comments from public, anon, authenticated;
revoke all on table public.community_likes from public, anon, authenticated;
grant select on table public.community_threads to authenticated;
grant select on table public.community_posts to authenticated;
grant select on table public.community_comments to authenticated;
grant select on table public.community_likes to authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
create function public.community_caller_membership()
returns public.school_memberships
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into membership
  from public.school_memberships row_membership
  where row_membership.user_id = auth.uid()
    and row_membership.status = 'verified'
  order by row_membership.created_at, row_membership.id
  limit 1;
  if membership.id is null or not public.is_member(membership.school_id) then
    raise exception 'verified membership required' using errcode = '42501';
  end if;
  return membership;
end;
$$;
revoke all on function public.community_caller_membership() from public, anon, authenticated;

create function public.community_thread_json(p_thread public.community_threads)
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
    'created_at', p_thread.created_at
  );
$$;
revoke all on function public.community_thread_json(public.community_threads)
  from public, anon, authenticated;

create function public.community_post_json(p_post public.community_posts)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_post.id,
    'school_id', p_post.school_id,
    'thread_id', p_post.thread_id,
    'author_id', p_post.author_id,
    'author_display_name', (
      select profile.display_name from public.profiles profile where profile.id = p_post.author_id
    ),
    'body', p_post.body,
    'status', p_post.status,
    'like_count', (
      select count(*)::integer from public.community_likes like_row
      where like_row.target_kind = 'post' and like_row.target_id = p_post.id
    ),
    'liked_by_me', exists (
      select 1 from public.community_likes like_row
      where like_row.target_kind = 'post'
        and like_row.target_id = p_post.id
        and like_row.liked_by = auth.uid()
    ),
    'created_at', p_post.created_at
  );
$$;
revoke all on function public.community_post_json(public.community_posts)
  from public, anon, authenticated;

create function public.community_comment_json(p_comment public.community_comments)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_comment.id,
    'school_id', p_comment.school_id,
    'post_id', p_comment.post_id,
    'author_id', p_comment.author_id,
    'author_display_name', (
      select profile.display_name from public.profiles profile where profile.id = p_comment.author_id
    ),
    'body', p_comment.body,
    'status', p_comment.status,
    'like_count', (
      select count(*)::integer from public.community_likes like_row
      where like_row.target_kind = 'comment' and like_row.target_id = p_comment.id
    ),
    'liked_by_me', exists (
      select 1 from public.community_likes like_row
      where like_row.target_kind = 'comment'
        and like_row.target_id = p_comment.id
        and like_row.liked_by = auth.uid()
    ),
    'created_at', p_comment.created_at
  );
$$;
revoke all on function public.community_comment_json(public.community_comments)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------
create function public.create_community_thread(p_title text, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  created_thread public.community_threads%rowtype;
  created_post public.community_posts%rowtype;
begin
  membership := public.community_caller_membership();
  if not public.community_text_is_allowed(p_title)
    or not public.community_text_is_allowed(p_body) then
    raise exception 'community text must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;

  insert into public.community_threads (
    school_id, author_id, author_membership, title
  ) values (
    membership.school_id, auth.uid(), membership.id, trim(p_title)
  ) returning * into created_thread;

  insert into public.community_posts (
    school_id, thread_id, author_id, author_membership, body
  ) values (
    membership.school_id, created_thread.id, auth.uid(), membership.id, trim(p_body)
  ) returning * into created_post;

  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), membership.school_id, 'community.thread_created', 'community_thread',
    created_thread.id,
    pg_catalog.jsonb_build_object('outcome', 'created', 'reason_code', 'community_thread')
  );

  return pg_catalog.jsonb_build_object(
    'thread', public.community_thread_json(created_thread),
    'post', public.community_post_json(created_post)
  );
end;
$$;
revoke all on function public.create_community_thread(text, text) from public, anon, authenticated;
grant execute on function public.create_community_thread(text, text) to authenticated;

create function public.create_community_post(p_thread_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  thread public.community_threads%rowtype;
  created_post public.community_posts%rowtype;
begin
  membership := public.community_caller_membership();
  select * into thread from public.community_threads where id = p_thread_id;
  if thread.id is null
    or thread.school_id is distinct from membership.school_id
    or thread.status is distinct from 'active'
    or not public.is_member(thread.school_id) then
    raise exception 'community thread unavailable' using errcode = '42501';
  end if;
  if not public.community_text_is_allowed(p_body) then
    raise exception 'community text must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;

  insert into public.community_posts (
    school_id, thread_id, author_id, author_membership, body
  ) values (
    membership.school_id, thread.id, auth.uid(), membership.id, trim(p_body)
  ) returning * into created_post;

  return public.community_post_json(created_post);
end;
$$;
revoke all on function public.create_community_post(uuid, text) from public, anon, authenticated;
grant execute on function public.create_community_post(uuid, text) to authenticated;

create function public.create_community_comment(p_post_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  post public.community_posts%rowtype;
  created_comment public.community_comments%rowtype;
begin
  membership := public.community_caller_membership();
  select * into post from public.community_posts where id = p_post_id;
  if post.id is null
    or post.school_id is distinct from membership.school_id
    or post.status is distinct from 'active'
    or not public.is_member(post.school_id) then
    raise exception 'community post unavailable' using errcode = '42501';
  end if;
  if not public.community_text_is_allowed(p_body) then
    raise exception 'community text must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;

  insert into public.community_comments (
    school_id, post_id, author_id, author_membership, body
  ) values (
    membership.school_id, post.id, auth.uid(), membership.id, trim(p_body)
  ) returning * into created_comment;

  return public.community_comment_json(created_comment);
end;
$$;
revoke all on function public.create_community_comment(uuid, text) from public, anon, authenticated;
grant execute on function public.create_community_comment(uuid, text) to authenticated;

create function public.toggle_community_like(p_target_kind text, p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  school uuid;
  existing public.community_likes%rowtype;
  liked boolean;
begin
  membership := public.community_caller_membership();
  if p_target_kind is distinct from 'post' and p_target_kind is distinct from 'comment' then
    raise exception 'community like target is invalid' using errcode = '22023';
  end if;

  if p_target_kind = 'post' then
    select post.school_id into school
    from public.community_posts post
    where post.id = p_target_id and post.status = 'active';
  else
    select comment.school_id into school
    from public.community_comments comment
    where comment.id = p_target_id and comment.status = 'active';
  end if;

  if school is null
    or school is distinct from membership.school_id
    or not public.is_member(school) then
    raise exception 'community like target unavailable' using errcode = '42501';
  end if;

  select * into existing
  from public.community_likes like_row
  where like_row.liked_by = auth.uid()
    and like_row.target_kind = p_target_kind
    and like_row.target_id = p_target_id
  for update;

  if existing.id is not null then
    perform set_config('yourturn.community_unlike', '1', true);
    delete from public.community_likes where id = existing.id;
    perform set_config('yourturn.community_unlike', '0', true);
    liked := false;
  else
    insert into public.community_likes (
      school_id, target_kind, target_id, liked_by, liked_by_membership
    ) values (
      membership.school_id, p_target_kind, p_target_id, auth.uid(), membership.id
    );
    liked := true;
  end if;

  return pg_catalog.jsonb_build_object(
    'target_kind', p_target_kind,
    'target_id', p_target_id,
    'liked', liked,
    'like_count', (
      select count(*)::integer from public.community_likes like_row
      where like_row.target_kind = p_target_kind and like_row.target_id = p_target_id
    )
  );
end;
$$;
revoke all on function public.toggle_community_like(text, uuid) from public, anon, authenticated;
grant execute on function public.toggle_community_like(text, uuid) to authenticated;

create function public.list_community_threads()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  result jsonb;
begin
  membership := public.community_caller_membership();
  select coalesce(pg_catalog.jsonb_agg(public.community_thread_json(thread) order by thread.created_at desc),
                  '[]'::jsonb)
    into result
  from public.community_threads thread
  where thread.school_id = membership.school_id
    and thread.status = 'active'
    and public.is_member(thread.school_id);
  return result;
end;
$$;
revoke all on function public.list_community_threads() from public, anon, authenticated;
grant execute on function public.list_community_threads() to authenticated;

create function public.list_community_posts(p_thread_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  thread public.community_threads%rowtype;
  result jsonb;
begin
  membership := public.community_caller_membership();
  select * into thread from public.community_threads where id = p_thread_id;
  if thread.id is null
    or thread.school_id is distinct from membership.school_id
    or thread.status is distinct from 'active'
    or not public.is_member(thread.school_id) then
    raise exception 'community thread unavailable' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.jsonb_agg(public.community_post_json(post) order by post.created_at),
                  '[]'::jsonb)
    into result
  from public.community_posts post
  where post.thread_id = thread.id
    and post.status = 'active';
  return result;
end;
$$;
revoke all on function public.list_community_posts(uuid) from public, anon, authenticated;
grant execute on function public.list_community_posts(uuid) to authenticated;

create function public.list_community_comments(p_post_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  post public.community_posts%rowtype;
  result jsonb;
begin
  membership := public.community_caller_membership();
  select * into post from public.community_posts where id = p_post_id;
  if post.id is null
    or post.school_id is distinct from membership.school_id
    or post.status is distinct from 'active'
    or not public.is_member(post.school_id) then
    raise exception 'community post unavailable' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.jsonb_agg(public.community_comment_json(comment) order by comment.created_at),
                  '[]'::jsonb)
    into result
  from public.community_comments comment
  where comment.post_id = post.id
    and comment.status = 'active';
  return result;
end;
$$;
revoke all on function public.list_community_comments(uuid) from public, anon, authenticated;
grant execute on function public.list_community_comments(uuid) to authenticated;

commit;

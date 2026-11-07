-- Task 8.2: community reporting, auto-hide after 3 unique reports,
-- own-school moderator hide/restore/remove and append-only moderation audit.
-- No photos, phones, emails, child full names, nicknames, trust scores,
-- amount, price, currency or live location.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Status: allow hidden (auto or moderator) alongside active / withdrawn
-- ---------------------------------------------------------------------------
alter table public.community_threads
  drop constraint if exists community_threads_status_check;
alter table public.community_threads
  add constraint community_threads_status_check
  check (status in ('active', 'hidden', 'withdrawn'));

alter table public.community_posts
  drop constraint if exists community_posts_status_check;
alter table public.community_posts
  add constraint community_posts_status_check
  check (status in ('active', 'hidden', 'withdrawn'));

alter table public.community_comments
  drop constraint if exists community_comments_status_check;
alter table public.community_comments
  add constraint community_comments_status_check
  check (status in ('active', 'hidden', 'withdrawn'));

-- ---------------------------------------------------------------------------
-- Reports and append-only moderation audit
-- ---------------------------------------------------------------------------
create table public.community_reports (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  target_kind text not null check (target_kind in ('thread', 'post', 'comment')),
  target_id uuid not null,
  reporter_id uuid not null references public.profiles(id) on delete restrict,
  reporter_membership uuid not null,
  reason text not null
    check (char_length(trim(reason)) between 3 and 500),
  created_at timestamptz not null default pg_catalog.now(),
  unique (reporter_id, target_kind, target_id),
  foreign key (reporter_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict
);
create index community_reports_target_idx
  on public.community_reports (target_kind, target_id, created_at);
create index community_reports_school_idx
  on public.community_reports (school_id, created_at desc);

comment on table public.community_reports is
  'Unique member reports on school community content. Reason text only; no photos phones nicknames or money fields.';

create table public.community_moderation_actions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  target_kind text not null check (target_kind in ('thread', 'post', 'comment')),
  target_id uuid not null,
  action text not null
    check (action in ('report_received', 'auto_hide', 'hide', 'restore', 'remove')),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  actor_membership uuid,
  report_count integer
    check (report_count is null or report_count >= 0),
  note text
    check (note is null or char_length(trim(note)) between 1 and 500),
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (actor_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict
);
create index community_moderation_actions_target_idx
  on public.community_moderation_actions (target_kind, target_id, created_at);
create index community_moderation_actions_school_idx
  on public.community_moderation_actions (school_id, created_at desc);

comment on table public.community_moderation_actions is
  'Append-only community moderation audit. No phone email nickname amount price or currency fields.';

-- ---------------------------------------------------------------------------
-- Guard: allow status transitions only under moderation GUC
-- ---------------------------------------------------------------------------
create or replace function public.guard_community_discussion()
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
    if current_setting('yourturn.community_moderation', true) = '1' then
      if tg_table_name = 'community_threads' then
        if new.id is distinct from old.id
          or new.school_id is distinct from old.school_id
          or new.author_id is distinct from old.author_id
          or new.author_membership is distinct from old.author_membership
          or new.created_at is distinct from old.created_at
          or new.title is distinct from old.title then
          raise exception 'community moderation may only change status'
            using errcode = '55000';
        end if;
        if not (
          (old.status = 'active' and new.status in ('hidden', 'withdrawn'))
          or (old.status = 'hidden' and new.status in ('active', 'withdrawn'))
        ) then
          raise exception 'community status transition is not allowed'
            using errcode = '22023';
        end if;
        return new;
      elsif tg_table_name = 'community_posts' then
        if new.id is distinct from old.id
          or new.school_id is distinct from old.school_id
          or new.author_id is distinct from old.author_id
          or new.author_membership is distinct from old.author_membership
          or new.created_at is distinct from old.created_at
          or new.thread_id is distinct from old.thread_id
          or new.body is distinct from old.body then
          raise exception 'community moderation may only change status'
            using errcode = '55000';
        end if;
        if not (
          (old.status = 'active' and new.status in ('hidden', 'withdrawn'))
          or (old.status = 'hidden' and new.status in ('active', 'withdrawn'))
        ) then
          raise exception 'community status transition is not allowed'
            using errcode = '22023';
        end if;
        return new;
      elsif tg_table_name = 'community_comments' then
        if new.id is distinct from old.id
          or new.school_id is distinct from old.school_id
          or new.author_id is distinct from old.author_id
          or new.author_membership is distinct from old.author_membership
          or new.created_at is distinct from old.created_at
          or new.post_id is distinct from old.post_id
          or new.body is distinct from old.body then
          raise exception 'community moderation may only change status'
            using errcode = '55000';
        end if;
        if not (
          (old.status = 'active' and new.status in ('hidden', 'withdrawn'))
          or (old.status = 'hidden' and new.status in ('active', 'withdrawn'))
        ) then
          raise exception 'community status transition is not allowed'
            using errcode = '22023';
        end if;
        return new;
      end if;
    end if;
    raise exception 'community discussion rows are immutable without moderation gate'
      using errcode = '55000';
  end if;

  if tg_table_name = 'community_threads' then
    if not public.community_text_is_allowed(new.title) then
      raise exception 'community text must not include phones, emails, photos or child full names'
        using errcode = '22023';
    end if;
  elsif tg_table_name = 'community_posts' or tg_table_name = 'community_comments' then
    if not public.community_text_is_allowed(new.body) then
      raise exception 'community text must not include phones, emails, photos or child full names'
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_community_discussion() from public, anon, authenticated;

create function public.guard_community_moderation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'UPDATE' or tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'community moderation history is append-only' using errcode = '55000';
  end if;
  if tg_table_name = 'community_reports' then
    if not public.community_text_is_allowed(new.reason) then
      raise exception 'community text must not include phones, emails, photos or child full names'
        using errcode = '22023';
    end if;
  elsif tg_table_name = 'community_moderation_actions' then
    if new.note is not null
      and not public.community_text_is_allowed(new.note) then
      raise exception 'community text must not include phones, emails, photos or child full names'
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_community_moderation() from public, anon, authenticated;

create trigger community_reports_guard_rows
  before insert or update or delete on public.community_reports
  for each row execute function public.guard_community_moderation();
create trigger community_reports_guard_truncate
  before truncate on public.community_reports
  for each statement execute function public.guard_community_moderation();
alter table public.community_reports enable always trigger community_reports_guard_rows;
alter table public.community_reports enable always trigger community_reports_guard_truncate;

create trigger community_moderation_actions_guard_rows
  before insert or update or delete on public.community_moderation_actions
  for each row execute function public.guard_community_moderation();
create trigger community_moderation_actions_guard_truncate
  before truncate on public.community_moderation_actions
  for each statement execute function public.guard_community_moderation();
alter table public.community_moderation_actions
  enable always trigger community_moderation_actions_guard_rows;
alter table public.community_moderation_actions
  enable always trigger community_moderation_actions_guard_truncate;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.community_reports enable row level security;
alter table public.community_moderation_actions enable row level security;

drop policy if exists community_threads_select on public.community_threads;
create policy community_threads_select on public.community_threads
  for select to authenticated using (
    public.is_admin()
    or (status = 'active' and public.is_member(school_id))
    or public.is_moderator(school_id)
  );

drop policy if exists community_posts_select on public.community_posts;
create policy community_posts_select on public.community_posts
  for select to authenticated using (
    public.is_admin()
    or (status = 'active' and public.is_member(school_id))
    or public.is_moderator(school_id)
  );

drop policy if exists community_comments_select on public.community_comments;
create policy community_comments_select on public.community_comments
  for select to authenticated using (
    public.is_admin()
    or (status = 'active' and public.is_member(school_id))
    or public.is_moderator(school_id)
  );

create policy community_reports_select on public.community_reports
  for select to authenticated using (
    public.is_admin()
    or reporter_id = auth.uid()
    or public.is_moderator(school_id)
  );

create policy community_moderation_actions_select on public.community_moderation_actions
  for select to authenticated using (
    public.is_admin()
    or public.is_moderator(school_id)
  );

revoke all on table public.community_reports from public, anon, authenticated;
revoke all on table public.community_moderation_actions from public, anon, authenticated;
grant select on table public.community_reports to authenticated;
grant select on table public.community_moderation_actions to authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
create function public.community_target_school_and_author(
  p_target_kind text,
  p_target_id uuid,
  out o_school_id uuid,
  out o_author_id uuid,
  out o_status text
)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
begin
  if p_target_kind = 'thread' then
    select thread.school_id, thread.author_id, thread.status
      into o_school_id, o_author_id, o_status
    from public.community_threads thread where thread.id = p_target_id;
  elsif p_target_kind = 'post' then
    select post.school_id, post.author_id, post.status
      into o_school_id, o_author_id, o_status
    from public.community_posts post where post.id = p_target_id;
  elsif p_target_kind = 'comment' then
    select comment.school_id, comment.author_id, comment.status
      into o_school_id, o_author_id, o_status
    from public.community_comments comment where comment.id = p_target_id;
  else
    raise exception 'community target kind is invalid' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.community_target_school_and_author(text, uuid)
  from public, anon, authenticated;

create function public.community_apply_status(
  p_target_kind text,
  p_target_id uuid,
  p_new_status text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  updated integer := 0;
begin
  perform set_config('yourturn.community_moderation', '1', true);
  if p_target_kind = 'thread' then
    update public.community_threads
      set status = p_new_status
      where id = p_target_id;
    get diagnostics updated = row_count;
  elsif p_target_kind = 'post' then
    update public.community_posts
      set status = p_new_status
      where id = p_target_id;
    get diagnostics updated = row_count;
  elsif p_target_kind = 'comment' then
    update public.community_comments
      set status = p_new_status
      where id = p_target_id;
    get diagnostics updated = row_count;
  else
    raise exception 'community target kind is invalid' using errcode = '22023';
  end if;
  perform set_config('yourturn.community_moderation', '0', true);
  if updated <> 1 then
    raise exception 'community target unavailable' using errcode = '42501';
  end if;
  return p_new_status;
end;
$$;
revoke all on function public.community_apply_status(text, uuid, text)
  from public, anon, authenticated;

create function public.community_moderation_queue_item_json(
  p_target_kind text,
  p_target_id uuid,
  p_school_id uuid,
  p_status text,
  p_report_count integer,
  p_created_at timestamptz,
  p_title text,
  p_body text,
  p_author_display_name text
)
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'target_kind', p_target_kind,
    'target_id', p_target_id,
    'school_id', p_school_id,
    'status', p_status,
    'report_count', p_report_count,
    'created_at', p_created_at,
    'title', p_title,
    'body', p_body,
    'author_display_name', p_author_display_name
  );
$$;
revoke all on function public.community_moderation_queue_item_json(
  text, uuid, uuid, text, integer, timestamptz, text, text, text
) from public, anon, authenticated;

create function public.community_require_moderator_membership()
returns public.school_memberships
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
begin
  membership := public.community_caller_membership();
  if not (public.is_moderator(membership.school_id) or public.is_admin()) then
    raise exception 'school moderator or admin role required' using errcode = '42501';
  end if;
  return membership;
end;
$$;
revoke all on function public.community_require_moderator_membership()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------
create function public.report_community_content(
  p_target_kind text,
  p_target_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  target_school uuid;
  target_author uuid;
  target_status text;
  report_count integer;
  outcome text := 'reported';
  existing_id uuid;
begin
  membership := public.community_caller_membership();
  if p_target_kind is distinct from 'thread'
    and p_target_kind is distinct from 'post'
    and p_target_kind is distinct from 'comment' then
    raise exception 'community target kind is invalid' using errcode = '22023';
  end if;
  if not public.community_text_is_allowed(p_reason) then
    raise exception 'community text must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;

  select t.o_school_id, t.o_author_id, t.o_status
    into target_school, target_author, target_status
  from public.community_target_school_and_author(p_target_kind, p_target_id) as t;

  if target_school is null
    or target_school is distinct from membership.school_id
    or not public.is_member(target_school)
    or target_status is distinct from 'active' then
    raise exception 'community content unavailable' using errcode = '42501';
  end if;
  if target_author is not distinct from auth.uid() then
    raise exception 'authors cannot report their own community content'
      using errcode = '42501';
  end if;

  select report.id into existing_id
  from public.community_reports report
  where report.reporter_id = auth.uid()
    and report.target_kind = p_target_kind
    and report.target_id = p_target_id;
  if existing_id is not null then
    select count(*)::integer into report_count
    from public.community_reports report
    where report.target_kind = p_target_kind and report.target_id = p_target_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'already_reported',
      'target_kind', p_target_kind,
      'target_id', p_target_id,
      'status', target_status,
      'report_count', report_count
    );
  end if;

  insert into public.community_reports (
    school_id, target_kind, target_id, reporter_id, reporter_membership, reason
  ) values (
    membership.school_id, p_target_kind, p_target_id, auth.uid(), membership.id, trim(p_reason)
  );

  select count(*)::integer into report_count
  from public.community_reports report
  where report.target_kind = p_target_kind and report.target_id = p_target_id;

  insert into public.community_moderation_actions (
    school_id, target_kind, target_id, action, actor_id, actor_membership, report_count, note
  ) values (
    membership.school_id, p_target_kind, p_target_id, 'report_received',
    auth.uid(), membership.id, report_count, null
  );

  if report_count >= 3 then
    perform public.community_apply_status(p_target_kind, p_target_id, 'hidden');
    insert into public.community_moderation_actions (
      school_id, target_kind, target_id, action, actor_id, actor_membership, report_count, note
    ) values (
      membership.school_id, p_target_kind, p_target_id, 'auto_hide',
      auth.uid(), membership.id, report_count, 'auto-hidden after three unique reports'
    );
    insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
    values (
      auth.uid(), membership.school_id, 'community.auto_hidden', 'community_' || p_target_kind,
      p_target_id,
      pg_catalog.jsonb_build_object(
        'outcome', 'auto_hidden',
        'reason_code', 'three_unique_reports'
      )
    );
    outcome := 'auto_hidden';
    target_status := 'hidden';
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', outcome,
    'target_kind', p_target_kind,
    'target_id', p_target_id,
    'status', target_status,
    'report_count', report_count
  );
end;
$$;
revoke all on function public.report_community_content(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.report_community_content(text, uuid, text) to authenticated;

create function public.hide_community_content(p_target_kind text, p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  target_school uuid;
  target_author uuid;
  target_status text;
  report_count integer;
begin
  membership := public.community_require_moderator_membership();
  select t.o_school_id, t.o_author_id, t.o_status
    into target_school, target_author, target_status
  from public.community_target_school_and_author(p_target_kind, p_target_id) as t;
  if target_school is null
    or target_school is distinct from membership.school_id
    or not (public.is_moderator(target_school) or public.is_admin()) then
    raise exception 'community content unavailable' using errcode = '42501';
  end if;
  if target_status is distinct from 'active' then
    if target_status = 'hidden' then
      select count(*)::integer into report_count
      from public.community_reports report
      where report.target_kind = p_target_kind and report.target_id = p_target_id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'already_hidden',
        'target_kind', p_target_kind,
        'target_id', p_target_id,
        'status', 'hidden',
        'report_count', report_count
      );
    end if;
    raise exception 'community content unavailable' using errcode = '42501';
  end if;

  perform public.community_apply_status(p_target_kind, p_target_id, 'hidden');
  select count(*)::integer into report_count
  from public.community_reports report
  where report.target_kind = p_target_kind and report.target_id = p_target_id;
  insert into public.community_moderation_actions (
    school_id, target_kind, target_id, action, actor_id, actor_membership, report_count, note
  ) values (
    membership.school_id, p_target_kind, p_target_id, 'hide',
    auth.uid(), membership.id, report_count, null
  );
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), membership.school_id, 'community.hidden', 'community_' || p_target_kind,
    p_target_id,
    pg_catalog.jsonb_build_object('outcome', 'hidden', 'reason_code', 'moderator_hide')
  );
  return pg_catalog.jsonb_build_object(
    'outcome', 'hidden',
    'target_kind', p_target_kind,
    'target_id', p_target_id,
    'status', 'hidden',
    'report_count', report_count
  );
end;
$$;
revoke all on function public.hide_community_content(text, uuid)
  from public, anon, authenticated;
grant execute on function public.hide_community_content(text, uuid) to authenticated;

create function public.restore_community_content(p_target_kind text, p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  target_school uuid;
  target_author uuid;
  target_status text;
  report_count integer;
begin
  membership := public.community_require_moderator_membership();
  select t.o_school_id, t.o_author_id, t.o_status
    into target_school, target_author, target_status
  from public.community_target_school_and_author(p_target_kind, p_target_id) as t;
  if target_school is null
    or target_school is distinct from membership.school_id
    or not (public.is_moderator(target_school) or public.is_admin()) then
    raise exception 'community content unavailable' using errcode = '42501';
  end if;
  if target_status is distinct from 'hidden' then
    raise exception 'community content unavailable' using errcode = '42501';
  end if;

  perform public.community_apply_status(p_target_kind, p_target_id, 'active');
  select count(*)::integer into report_count
  from public.community_reports report
  where report.target_kind = p_target_kind and report.target_id = p_target_id;
  insert into public.community_moderation_actions (
    school_id, target_kind, target_id, action, actor_id, actor_membership, report_count, note
  ) values (
    membership.school_id, p_target_kind, p_target_id, 'restore',
    auth.uid(), membership.id, report_count, null
  );
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), membership.school_id, 'community.restored', 'community_' || p_target_kind,
    p_target_id,
    pg_catalog.jsonb_build_object('outcome', 'restored', 'reason_code', 'moderator_restore')
  );
  return pg_catalog.jsonb_build_object(
    'outcome', 'restored',
    'target_kind', p_target_kind,
    'target_id', p_target_id,
    'status', 'active',
    'report_count', report_count
  );
end;
$$;
revoke all on function public.restore_community_content(text, uuid)
  from public, anon, authenticated;
grant execute on function public.restore_community_content(text, uuid) to authenticated;

create function public.remove_community_content(p_target_kind text, p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  target_school uuid;
  target_author uuid;
  target_status text;
  report_count integer;
begin
  membership := public.community_require_moderator_membership();
  select t.o_school_id, t.o_author_id, t.o_status
    into target_school, target_author, target_status
  from public.community_target_school_and_author(p_target_kind, p_target_id) as t;
  if target_school is null
    or target_school is distinct from membership.school_id
    or not (public.is_moderator(target_school) or public.is_admin()) then
    raise exception 'community content unavailable' using errcode = '42501';
  end if;
  if target_status not in ('active', 'hidden') then
    if target_status = 'withdrawn' then
      select count(*)::integer into report_count
      from public.community_reports report
      where report.target_kind = p_target_kind and report.target_id = p_target_id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'already_removed',
        'target_kind', p_target_kind,
        'target_id', p_target_id,
        'status', 'withdrawn',
        'report_count', report_count
      );
    end if;
    raise exception 'community content unavailable' using errcode = '42501';
  end if;

  perform public.community_apply_status(p_target_kind, p_target_id, 'withdrawn');
  select count(*)::integer into report_count
  from public.community_reports report
  where report.target_kind = p_target_kind and report.target_id = p_target_id;
  insert into public.community_moderation_actions (
    school_id, target_kind, target_id, action, actor_id, actor_membership, report_count, note
  ) values (
    membership.school_id, p_target_kind, p_target_id, 'remove',
    auth.uid(), membership.id, report_count, null
  );
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), membership.school_id, 'community.removed', 'community_' || p_target_kind,
    p_target_id,
    pg_catalog.jsonb_build_object('outcome', 'removed', 'reason_code', 'moderator_remove')
  );
  return pg_catalog.jsonb_build_object(
    'outcome', 'removed',
    'target_kind', p_target_kind,
    'target_id', p_target_id,
    'status', 'withdrawn',
    'report_count', report_count
  );
end;
$$;
revoke all on function public.remove_community_content(text, uuid)
  from public, anon, authenticated;
grant execute on function public.remove_community_content(text, uuid) to authenticated;

create function public.list_community_moderation_queue()
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
  membership := public.community_require_moderator_membership();

  with targets as (
    select 'thread'::text as target_kind, thread.id as target_id, thread.school_id,
           thread.status, thread.created_at, thread.title, null::text as body,
           profile.display_name as author_display_name
    from public.community_threads thread
    join public.profiles profile on profile.id = thread.author_id
    where thread.school_id = membership.school_id
      and thread.status = 'hidden'
    union all
    select 'post', post.id, post.school_id, post.status, post.created_at, null, post.body,
           profile.display_name
    from public.community_posts post
    join public.profiles profile on profile.id = post.author_id
    where post.school_id = membership.school_id
      and post.status = 'hidden'
    union all
    select 'comment', comment.id, comment.school_id, comment.status, comment.created_at,
           null, comment.body, profile.display_name
    from public.community_comments comment
    join public.profiles profile on profile.id = comment.author_id
    where comment.school_id = membership.school_id
      and comment.status = 'hidden'
  ),
  counted as (
    select target.*,
      (
        select count(*)::integer from public.community_reports report
        where report.target_kind = target.target_kind
          and report.target_id = target.target_id
      ) as report_count
    from targets target
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      public.community_moderation_queue_item_json(
        counted.target_kind, counted.target_id, counted.school_id, counted.status,
        counted.report_count, counted.created_at, counted.title, counted.body,
        counted.author_display_name
      ) order by counted.created_at desc
    ),
    '[]'::jsonb
  ) into result
  from counted;

  return result;
end;
$$;
revoke all on function public.list_community_moderation_queue()
  from public, anon, authenticated;
grant execute on function public.list_community_moderation_queue() to authenticated;

commit;

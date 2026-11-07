-- Task 8.2 remediation: split guard IF branches so NEW fields are only
-- referenced on the matching table (avoids 42703 record field errors).
begin;
set local search_path = pg_catalog;

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

create or replace function public.guard_community_moderation()
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

-- Safe audit payloads: only string keys source/outcome/reason_code/previous_status/next_status/version.
create or replace function public.report_community_content(
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

create or replace function public.hide_community_content(p_target_kind text, p_target_id uuid)
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

create or replace function public.restore_community_content(p_target_kind text, p_target_id uuid)
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

create or replace function public.remove_community_content(p_target_kind text, p_target_id uuid)
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

commit;

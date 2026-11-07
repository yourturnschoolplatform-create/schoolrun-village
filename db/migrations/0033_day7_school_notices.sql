-- Task 7.1: phone-free school collection notices and school-scoped moderation.
-- Notice payload is year level(s), service date, and collector display name only.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.school_notices (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  swap_id uuid not null,
  swap_leg_id uuid not null,
  generated_by uuid not null references public.profiles(id) on delete restrict,
  service_date date not null,
  year_levels smallint[] not null,
  collector_display_name text not null
    check (char_length(collector_display_name) between 2 and 80),
  notice_body text not null
    check (char_length(notice_body) between 20 and 500),
  status text not null check (status in ('active', 'withdrawn')),
  created_at timestamptz not null default pg_catalog.now(),
  withdrawn_at timestamptz,
  withdrawn_by uuid references public.profiles(id) on delete restrict,
  check (pg_catalog.cardinality(year_levels) >= 1),
  check ((status = 'active') = (withdrawn_at is null and withdrawn_by is null)),
  check ((status = 'withdrawn') = (withdrawn_at is not null and withdrawn_by is not null)),
  foreign key (swap_leg_id, school_id) references public.swap_legs(id, school_id) on delete restrict,
  foreign key (swap_id) references public.swap_proposals(id) on delete restrict
);
create unique index school_notices_one_active_per_leg_idx
  on public.school_notices (swap_leg_id)
  where status = 'active';
create index school_notices_school_status_idx
  on public.school_notices (school_id, status, created_at desc);
create index school_notices_generator_idx
  on public.school_notices (generated_by, created_at desc);
alter table public.school_notices
  add constraint school_notices_id_school_key unique (id, school_id);

comment on table public.school_notices is
  'Phone-free school collection notices: year levels, date, collector display name only. No nickname, phone, email, address, trust score, amount, price or currency.';

create table public.school_notice_access_logs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  notice_id uuid not null,
  actor_user_id uuid not null references public.profiles(id) on delete restrict,
  action text not null check (action in ('generated', 'viewed', 'withdrawn')),
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (notice_id, school_id) references public.school_notices(id, school_id) on delete restrict
);
create index school_notice_access_logs_notice_idx
  on public.school_notice_access_logs (notice_id, created_at desc);
create index school_notice_access_logs_school_idx
  on public.school_notice_access_logs (school_id, created_at desc);

comment on table public.school_notice_access_logs is
  'Append-only access history for school notices; retention purge is Task 7.3. No phone or child nickname fields.';

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
create function public.guard_school_notice_history()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_table_name = 'school_notice_access_logs' then
    if tg_op <> 'INSERT' then
      raise exception 'school notice access logs are append-only' using errcode = '55000';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'school notices cannot be deleted' using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' then
    if (new.id, new.school_id, new.swap_id, new.swap_leg_id, new.generated_by,
        new.service_date, new.year_levels, new.collector_display_name, new.notice_body,
        new.created_at)
      is distinct from
       (old.id, old.school_id, old.swap_id, old.swap_leg_id, old.generated_by,
        old.service_date, old.year_levels, old.collector_display_name, old.notice_body,
        old.created_at)
    then
      raise exception 'school notice identity fields are immutable' using errcode = '55000';
    end if;
    if old.status = 'withdrawn' then
      raise exception 'withdrawn school notices are immutable' using errcode = '55000';
    end if;
    if not (old.status = 'active' and new.status = 'withdrawn'
      and new.withdrawn_at is not null and new.withdrawn_by is not null) then
      raise exception 'school notices may only transition active to withdrawn' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_school_notice_history() from public, anon, authenticated;

create trigger school_notices_guard_rows
  before insert or update or delete on public.school_notices
  for each row execute function public.guard_school_notice_history();
create trigger school_notices_guard_truncate
  before truncate on public.school_notices
  for each statement execute function public.guard_school_notice_history();
alter table public.school_notices enable always trigger school_notices_guard_rows;
alter table public.school_notices enable always trigger school_notices_guard_truncate;

create trigger school_notice_access_logs_guard_rows
  before insert or update or delete on public.school_notice_access_logs
  for each row execute function public.guard_school_notice_history();
create trigger school_notice_access_logs_guard_truncate
  before truncate on public.school_notice_access_logs
  for each statement execute function public.guard_school_notice_history();
alter table public.school_notice_access_logs enable always trigger school_notice_access_logs_guard_rows;
alter table public.school_notice_access_logs enable always trigger school_notice_access_logs_guard_truncate;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.school_notices enable row level security;
alter table public.school_notice_access_logs enable row level security;

create policy school_notices_select on public.school_notices
  for select to authenticated using (
    public.is_admin()
    or public.is_moderator(school_id)
    or generated_by = auth.uid()
    or exists (
      select 1
      from public.swap_legs leg
      where leg.id = school_notices.swap_leg_id
        and leg.school_id = school_notices.school_id
        and auth.uid() in (leg.helper_id, leg.requester_id)
        and public.is_member(leg.school_id)
    )
  );

create policy school_notice_access_logs_select on public.school_notice_access_logs
  for select to authenticated using (
    public.is_admin()
    or public.is_moderator(school_id)
    or actor_user_id = auth.uid()
    or exists (
      select 1
      from public.school_notices notice
      where notice.id = school_notice_access_logs.notice_id
        and notice.school_id = school_notice_access_logs.school_id
        and (
          notice.generated_by = auth.uid()
          or exists (
            select 1 from public.swap_legs leg
            where leg.id = notice.swap_leg_id
              and leg.school_id = notice.school_id
              and auth.uid() in (leg.helper_id, leg.requester_id)
          )
        )
    )
  );

revoke all on table public.school_notices from public, anon, authenticated;
revoke all on table public.school_notice_access_logs from public, anon, authenticated;
grant select on table public.school_notices to authenticated;
grant select on table public.school_notice_access_logs to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function public.school_notice_year_label(p_levels smallint[])
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog
as $$
declare
  sorted smallint[];
  label text;
begin
  select pg_catalog.array_agg(level order by level)
    into sorted
  from pg_catalog.unnest(p_levels) as level;
  if sorted is null or pg_catalog.cardinality(sorted) = 0 then
    raise exception 'year level required' using errcode = '22023';
  end if;
  if pg_catalog.cardinality(sorted) = 1 then
    return 'Year ' || sorted[1]::text;
  end if;
  select pg_catalog.string_agg(level::text, ', ' order by level)
    into label
  from pg_catalog.unnest(sorted) as level;
  return 'Years ' || label;
end;
$$;
revoke all on function public.school_notice_year_label(smallint[]) from public, anon, authenticated;

create function public.school_notice_build_body(
  p_service_date date,
  p_year_levels smallint[],
  p_collector_display_name text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select 'Collection notice — '
    || pg_catalog.to_char(p_service_date, 'YYYY-MM-DD')
    || E'\nYear level: '
    || public.school_notice_year_label(p_year_levels)
    || E'\nCollector: '
    || p_collector_display_name;
$$;
revoke all on function public.school_notice_build_body(date, smallint[], text)
  from public, anon, authenticated;

create function public.school_notice_json(p_notice public.school_notices)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_notice.id,
    'school_id', p_notice.school_id,
    'swap_leg_id', p_notice.swap_leg_id,
    'service_date', p_notice.service_date,
    'year_levels', pg_catalog.to_jsonb(p_notice.year_levels),
    'collector_display_name', p_notice.collector_display_name,
    'notice_body', p_notice.notice_body,
    'status', p_notice.status,
    'created_at', p_notice.created_at,
    'withdrawn_at', p_notice.withdrawn_at
  );
$$;
revoke all on function public.school_notice_json(public.school_notices)
  from public, anon, authenticated;

create function public.log_school_notice_access(
  p_notice_id uuid,
  p_school_id uuid,
  p_action text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  insert into public.school_notice_access_logs (school_id, notice_id, actor_user_id, action)
  values (p_school_id, p_notice_id, auth.uid(), p_action);
end;
$$;
revoke all on function public.log_school_notice_access(uuid, uuid, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------
create function public.generate_school_notice(p_swap_leg_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  leg public.swap_legs%rowtype;
  proposal public.swap_proposals%rowtype;
  collector public.profiles%rowtype;
  existing_notice public.school_notices%rowtype;
  created_notice public.school_notices%rowtype;
  levels smallint[];
  body text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into leg from public.swap_legs where id = p_swap_leg_id for update;
  if leg.id is null then
    raise exception 'swap leg not found' using errcode = 'P0002';
  end if;
  select * into proposal from public.swap_proposals where id = leg.swap_id for update;
  if proposal.status is distinct from 'accepted'
    or proposal.school_id is distinct from leg.school_id then
    raise exception 'accepted same-school swap required' using errcode = '42501';
  end if;
  if auth.uid() not in (leg.helper_id, leg.requester_id)
    or not public.is_member(leg.school_id) then
    raise exception 'accepted swap participant required' using errcode = '42501';
  end if;
  if not public.is_member(leg.school_id) then
    raise exception 'verified active membership required' using errcode = '42501';
  end if;

  select row_notice.* into existing_notice
  from public.school_notices as row_notice
  where row_notice.swap_leg_id = leg.id and row_notice.status = 'active'
  for update;
  if existing_notice.id is not null then
    perform public.log_school_notice_access(
      existing_notice.id, existing_notice.school_id, 'viewed');
    return public.school_notice_json(existing_notice);
  end if;

  select pg_catalog.array_agg(distinct child.year_level order by child.year_level)
    into levels
  from public.child_profiles child
  join public.school_memberships membership
    on membership.id = child.membership_id
  where child.parent_id = leg.requester_id
    and membership.user_id = leg.requester_id
    and membership.school_id = leg.school_id
    and membership.status = 'verified';
  if levels is null or pg_catalog.cardinality(levels) = 0 then
    raise exception 'requester year level required' using errcode = '22023';
  end if;

  select * into collector from public.profiles where id = leg.helper_id;
  if collector.id is null or char_length(collector.display_name) not between 2 and 80 then
    raise exception 'collector display name required' using errcode = '22023';
  end if;

  body := public.school_notice_build_body(leg.service_date, levels, collector.display_name);
  if body ~* '(phone|mobile|email|@|nickname|trust|score|\$|price|AUD|amount|currency|address)' then
    raise exception 'school notice must stay phone-free' using errcode = '22023';
  end if;

  insert into public.school_notices (
    school_id, swap_id, swap_leg_id, generated_by, service_date,
    year_levels, collector_display_name, notice_body, status
  ) values (
    leg.school_id, leg.swap_id, leg.id, auth.uid(), leg.service_date,
    levels, collector.display_name, body, 'active'
  ) returning * into created_notice;

  perform public.log_school_notice_access(
    created_notice.id, created_notice.school_id, 'generated');
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), created_notice.school_id, 'school_notice.generated', 'school_notice',
    created_notice.id, pg_catalog.jsonb_build_object('outcome', 'generated')
  );
  return public.school_notice_json(created_notice);
end;
$$;
revoke all on function public.generate_school_notice(uuid) from public, anon, authenticated;
grant execute on function public.generate_school_notice(uuid) to authenticated;

create function public.get_school_notice(p_notice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  notice public.school_notices%rowtype;
  allowed boolean := false;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into notice from public.school_notices where id = p_notice_id;
  if notice.id is null then
    raise exception 'school notice not found' using errcode = 'P0002';
  end if;

  if public.is_admin() or public.is_moderator(notice.school_id) then
    allowed := true;
  elsif notice.generated_by = auth.uid() then
    allowed := true;
  elsif exists (
    select 1 from public.swap_legs leg
    where leg.id = notice.swap_leg_id
      and leg.school_id = notice.school_id
      and auth.uid() in (leg.helper_id, leg.requester_id)
      and public.is_member(leg.school_id)
  ) then
    allowed := true;
  end if;
  if not allowed then
    raise exception 'school notice access denied' using errcode = '42501';
  end if;

  perform public.log_school_notice_access(notice.id, notice.school_id, 'viewed');
  return public.school_notice_json(notice);
end;
$$;
revoke all on function public.get_school_notice(uuid) from public, anon, authenticated;
grant execute on function public.get_school_notice(uuid) to authenticated;

create function public.list_my_school_notices()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select coalesce(pg_catalog.jsonb_agg(public.school_notice_json(notice)
    order by notice.created_at desc, notice.id), '[]'::jsonb)
  from public.school_notices notice
  where notice.generated_by = auth.uid()
     or exists (
       select 1 from public.swap_legs leg
       where leg.id = notice.swap_leg_id
         and leg.school_id = notice.school_id
         and auth.uid() in (leg.helper_id, leg.requester_id)
         and public.is_member(leg.school_id)
     );
$$;
revoke all on function public.list_my_school_notices() from public, anon, authenticated;
grant execute on function public.list_my_school_notices() to authenticated;

create function public.list_school_notice_moderation_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  school uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select membership.school_id into school
  from public.school_memberships membership
  where membership.user_id = auth.uid()
    and membership.status = 'verified'
    and (public.is_moderator(membership.school_id) or public.is_admin())
  order by membership.created_at, membership.id
  limit 1;
  if school is null then
    raise exception 'school moderator or admin role required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'school_id', school,
    'notices', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', notice.id,
        'swap_leg_id', notice.swap_leg_id,
        'service_date', notice.service_date,
        'year_levels', pg_catalog.to_jsonb(notice.year_levels),
        'collector_display_name', notice.collector_display_name,
        'notice_body', notice.notice_body,
        'status', notice.status,
        'created_at', notice.created_at,
        'generated_by', notice.generated_by
      ) order by notice.created_at desc, notice.id)
      from public.school_notices notice
      where notice.school_id = school and notice.status = 'active'
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.list_school_notice_moderation_queue()
  from public, anon, authenticated;
grant execute on function public.list_school_notice_moderation_queue() to authenticated;

create function public.withdraw_school_notice(p_notice_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  notice public.school_notices%rowtype;
  allowed boolean := false;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into notice from public.school_notices where id = p_notice_id for update;
  if notice.id is null then
    raise exception 'school notice not found' using errcode = 'P0002';
  end if;
  if notice.status = 'withdrawn' then
    return 'already_withdrawn';
  end if;

  if public.is_admin() or public.is_moderator(notice.school_id) then
    allowed := true;
  elsif notice.generated_by = auth.uid() then
    allowed := true;
  end if;
  if not allowed then
    raise exception 'school notice withdraw denied' using errcode = '42501';
  end if;

  update public.school_notices
  set status = 'withdrawn',
      withdrawn_at = pg_catalog.now(),
      withdrawn_by = auth.uid()
  where id = notice.id;

  perform public.log_school_notice_access(notice.id, notice.school_id, 'withdrawn');
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), notice.school_id, 'school_notice.withdrawn', 'school_notice', notice.id,
    pg_catalog.jsonb_build_object('outcome', 'withdrawn')
  );
  return 'withdrawn';
end;
$$;
revoke all on function public.withdraw_school_notice(uuid) from public, anon, authenticated;
grant execute on function public.withdraw_school_notice(uuid) to authenticated;

commit;

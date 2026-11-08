-- Day 11: same-school same-day instant pickup/help board (Karrot-style request feed).
-- Uses existing schedule_intent / school_run_direction enums. Suburb-only area labels.
-- Phone-free notes via community_text_is_allowed. Writes via RPCs only.
-- Realtime: instant_pickup_requests added to supabase_realtime when publication exists.
begin;
set local search_path = pg_catalog;

create type public.instant_pickup_status as enum (
  'open', 'matched', 'expired', 'cancelled'
);

create table public.instant_pickup_requests (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  intent public.schedule_intent not null,
  direction public.school_run_direction not null,
  target_date date not null default (
    (pg_catalog.timezone('Australia/Sydney', pg_catalog.now()))::date
  ),
  area_label text not null
    check (char_length(trim(area_label)) between 2 and 64)
    check (public.is_suburb_area_label(area_label)),
  notes text
    check (notes is null or char_length(trim(notes)) between 1 and 500),
  status public.instant_pickup_status not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (target_date >= ((pg_catalog.timezone('Australia/Sydney', created_at))::date - 1))
);

create index instant_pickup_requests_school_open_idx
  on public.instant_pickup_requests (school_id, status, target_date desc, created_at desc);
create index instant_pickup_requests_requester_idx
  on public.instant_pickup_requests (requester_id, created_at desc);

comment on table public.instant_pickup_requests is
  'Same-school same-day need-help / can-help board. Suburb label only; no phone, address or money.';

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
create function public.guard_instant_pickup_requests()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'instant pickup requests cannot be deleted' using errcode = '55000';
  end if;

  if tg_op = 'INSERT' then
    if current_setting('yourturn.instant_pickup_mutate', true) is distinct from '1' then
      raise exception 'instant pickup requests insert only through create RPC'
        using errcode = '42501';
    end if;
    if new.notes is not null and not public.community_text_is_allowed(new.notes) then
      raise exception 'instant pickup notes must not include phones, emails, photos or child full names'
        using errcode = '22023';
    end if;
    if not public.is_suburb_area_label(new.area_label) then
      raise exception 'suburb-level area label required' using errcode = '22023';
    end if;
    return new;
  end if;

  -- UPDATE
  if current_setting('yourturn.instant_pickup_mutate', true) is distinct from '1' then
    raise exception 'instant pickup requests update only through RPCs'
      using errcode = '42501';
  end if;
  if (new.id, new.school_id, new.requester_id, new.intent, new.direction,
      new.target_date, new.area_label, new.notes, new.created_at)
    is distinct from
     (old.id, old.school_id, old.requester_id, old.intent, old.direction,
      old.target_date, old.area_label, old.notes, old.created_at) then
    raise exception 'instant pickup request fields are immutable except status'
      using errcode = '55000';
  end if;
  if old.status is distinct from 'open' and new.status is distinct from old.status then
    raise exception 'closed instant pickup requests cannot change status'
      using errcode = '55000';
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function public.guard_instant_pickup_requests() from public, anon, authenticated;

create trigger instant_pickup_requests_guard_rows
  before insert or update or delete on public.instant_pickup_requests
  for each row execute function public.guard_instant_pickup_requests();
create trigger instant_pickup_requests_guard_truncate
  before truncate on public.instant_pickup_requests
  for each statement execute function public.guard_instant_pickup_requests();
alter table public.instant_pickup_requests enable always trigger instant_pickup_requests_guard_rows;
alter table public.instant_pickup_requests enable always trigger instant_pickup_requests_guard_truncate;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.instant_pickup_requests enable row level security;
revoke all on table public.instant_pickup_requests from public, anon, authenticated;
grant select on table public.instant_pickup_requests to authenticated;

create policy instant_pickup_requests_select on public.instant_pickup_requests
  for select to authenticated using (
    public.is_admin()
    or public.is_member(school_id)
  );

-- ---------------------------------------------------------------------------
-- Realtime (best-effort)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'instant_pickup_requests'
    ) then
    execute 'alter publication supabase_realtime add table public.instant_pickup_requests';
  end if;
exception
  when others then
    null;
end $$;

-- ---------------------------------------------------------------------------
-- Helpers / RPCs
-- ---------------------------------------------------------------------------
create function public.instant_pickup_caller_membership()
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
  from public.school_memberships as row_membership
  where row_membership.user_id = auth.uid()
    and row_membership.status = 'verified'
  order by row_membership.created_at asc
  limit 1;
  if membership.id is null or not public.is_member(membership.school_id) then
    raise exception 'verified membership required' using errcode = '42501';
  end if;
  return membership;
end;
$$;
revoke all on function public.instant_pickup_caller_membership()
  from public, anon, authenticated;

create function public.instant_pickup_request_json(
  p_request public.instant_pickup_requests
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  display_name text;
begin
  if auth.uid() is null or not public.is_member(p_request.school_id) then
    raise exception 'verified membership required' using errcode = '42501';
  end if;
  select profile.display_name into display_name
  from public.profiles as profile
  where profile.id = p_request.requester_id;
  return pg_catalog.jsonb_build_object(
    'id', p_request.id,
    'schoolId', p_request.school_id,
    'requesterId', p_request.requester_id,
    'requesterDisplayName', coalesce(display_name, 'Parent'),
    'intent', p_request.intent::text,
    'direction', p_request.direction::text,
    'targetDate', p_request.target_date,
    'areaLabel', p_request.area_label,
    'notes', p_request.notes,
    'status', p_request.status::text,
    'mine', p_request.requester_id = auth.uid(),
    'createdAt', p_request.created_at
  );
end;
$$;
revoke all on function public.instant_pickup_request_json(public.instant_pickup_requests)
  from public, anon, authenticated;

create function public.create_instant_pickup_request(
  p_intent text,
  p_direction text,
  p_area_label text,
  p_target_date date default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  school_today date;
  target date;
  created public.instant_pickup_requests%rowtype;
  notes_value text := nullif(trim(coalesce(p_notes, '')), '');
begin
  membership := public.instant_pickup_caller_membership();
  school_today := public.school_local_today(membership.school_id);
  target := coalesce(p_target_date, school_today);
  if target < school_today or target > school_today + 1 then
    raise exception 'instant pickup target date must be today or tomorrow'
      using errcode = '22023';
  end if;
  if p_intent not in ('can_help', 'need_help')
    or p_direction not in ('pickup', 'dropoff')
    or not public.is_suburb_area_label(trim(p_area_label)) then
    raise exception 'instant pickup request is invalid' using errcode = '22023';
  end if;
  if notes_value is not null and not public.community_text_is_allowed(notes_value) then
    raise exception 'instant pickup notes must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;

  -- One open request per parent per school/day/intent/direction.
  if exists (
    select 1 from public.instant_pickup_requests as existing
    where existing.school_id = membership.school_id
      and existing.requester_id = auth.uid()
      and existing.target_date = target
      and existing.intent = p_intent::public.schedule_intent
      and existing.direction = p_direction::public.school_run_direction
      and existing.status = 'open'
  ) then
    raise exception 'open instant pickup request already exists for this run'
      using errcode = '23505';
  end if;

  perform set_config('yourturn.instant_pickup_mutate', '1', true);
  insert into public.instant_pickup_requests (
    school_id, requester_id, intent, direction, target_date, area_label, notes
  ) values (
    membership.school_id,
    auth.uid(),
    p_intent::public.schedule_intent,
    p_direction::public.school_run_direction,
    target,
    trim(p_area_label),
    notes_value
  ) returning * into created;
  perform set_config('yourturn.instant_pickup_mutate', '', true);

  return public.instant_pickup_request_json(created);
end;
$$;
revoke all on function public.create_instant_pickup_request(text, text, text, date, text)
  from public, anon, authenticated;
grant execute on function public.create_instant_pickup_request(text, text, text, date, text)
  to authenticated;

create function public.list_instant_pickup_requests(p_include_closed boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  school_today date;
begin
  membership := public.instant_pickup_caller_membership();
  school_today := public.school_local_today(membership.school_id);
  return coalesce((
    select pg_catalog.jsonb_agg(public.instant_pickup_request_json(request) order by request.created_at desc)
    from public.instant_pickup_requests as request
    where request.school_id = membership.school_id
      and request.target_date >= school_today - 1
      and (
        p_include_closed
        or request.status = 'open'
        or request.requester_id = auth.uid()
      )
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_instant_pickup_requests(boolean)
  from public, anon, authenticated;
grant execute on function public.list_instant_pickup_requests(boolean) to authenticated;

create function public.cancel_instant_pickup_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  request public.instant_pickup_requests%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into request
  from public.instant_pickup_requests
  where id = p_request_id
  for update;
  if request.id is null
    or request.requester_id is distinct from auth.uid()
    or not public.is_member(request.school_id) then
    raise exception 'instant pickup request unavailable' using errcode = '42501';
  end if;
  if request.status is distinct from 'open' then
    return public.instant_pickup_request_json(request);
  end if;
  perform set_config('yourturn.instant_pickup_mutate', '1', true);
  update public.instant_pickup_requests as row_request
  set status = 'cancelled'
  where row_request.id = request.id
  returning * into request;
  perform set_config('yourturn.instant_pickup_mutate', '', true);
  return public.instant_pickup_request_json(request);
end;
$$;
revoke all on function public.cancel_instant_pickup_request(uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_instant_pickup_request(uuid) to authenticated;

commit;

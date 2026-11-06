-- YourTurn Day 3: household confirmation, recurring schedules, school calendar and cancellations.
-- No address, coordinate, map pin, route, phone, payment, or live-location field is created here.

begin;

-- ---------------------------------------------------------------------------
-- Day 3 explicit, bounded record types.
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.household_link_status as enum ('pending', 'confirmed', 'declined', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.schedule_intent as enum ('can_help', 'need_help');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.school_run_direction as enum ('pickup', 'dropoff');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.schedule_instance_status as enum ('open', 'cancelled', 'confirmed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.schedule_cancellation_scope as enum ('instance', 'pattern');
exception when duplicate_object then null; end $$;

-- Household records have no addresses, contact details, or profile lookups.
-- The requester has already confirmed by creating the request; the other
-- participant must explicitly confirm it before the link is effective.
create table if not exists public.household_links (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  first_parent_id uuid not null references public.profiles(id) on delete cascade,
  second_parent_id uuid not null references public.profiles(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  requester_confirmed_at timestamptz not null default now(),
  other_parent_confirmed_at timestamptz,
  status public.household_link_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (first_parent_id <> second_parent_id),
  check (requested_by = first_parent_id or requested_by = second_parent_id),
  check ((status = 'confirmed') = (other_parent_confirmed_at is not null))
);
create unique index if not exists household_links_active_pair_idx
  on public.household_links (school_id, least(first_parent_id, second_parent_id), greatest(first_parent_id, second_parent_id))
  where status in ('pending', 'confirmed');

-- An opaque, expiring code lets the other parent confirm a household link
-- without searching profiles, revealing school data, or exchanging an address.
create table if not exists public.household_link_invitations (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  invited_by uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  claimed_by uuid references public.profiles(id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check ((claimed_by is null) = (claimed_at is null))
);
create index if not exists household_link_invitations_owner_idx
  on public.household_link_invitations (invited_by, expires_at desc);

-- Term records bound the school programme; holidays always take precedence.
create table if not exists public.school_calendar_periods (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  period_type text not null check (period_type in ('term', 'holiday')),
  label text not null check (char_length(trim(label)) between 2 and 80),
  starts_on date not null,
  ends_on date not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create unique index if not exists school_calendar_periods_unique_window_idx
  on public.school_calendar_periods (school_id, period_type, starts_on, ends_on, label);
create index if not exists school_calendar_periods_range_idx
  on public.school_calendar_periods (school_id, starts_on, ends_on);

-- A pattern carries only school-run scheduling facts and a coarse area label.
create table if not exists public.availability_patterns (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  intent public.schedule_intent not null,
  direction public.school_run_direction not null,
  weekday smallint not null check (weekday between 1 and 7),
  window_start time not null,
  window_end time not null,
  area_label text not null check (char_length(trim(area_label)) between 2 and 64),
  capacity smallint not null check (capacity between 1 and 8),
  starts_on date not null,
  is_active boolean not null default true,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (window_end > window_start),
  check (is_active or cancelled_at is not null)
);
create index if not exists availability_patterns_owner_school_idx
  on public.availability_patterns (owner_id, school_id, is_active, weekday);

-- Dated instances are frozen in school-local date and local time terms. This
-- preserves intended local clock times through daylight-saving transitions.
create table if not exists public.availability_instances (
  id uuid primary key default gen_random_uuid(),
  pattern_id uuid not null references public.availability_patterns(id) on delete cascade,
  school_id uuid not null references public.schools(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  service_date date not null,
  intent public.schedule_intent not null,
  direction public.school_run_direction not null,
  window_start time not null,
  window_end time not null,
  area_label text not null check (char_length(trim(area_label)) between 2 and 64),
  capacity smallint not null check (capacity between 1 and 8),
  status public.schedule_instance_status not null default 'open',
  cancelled_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pattern_id, service_date),
  check (window_end > window_start),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check ((status = 'confirmed') = (confirmed_at is not null))
);
create index if not exists availability_instances_owner_date_idx
  on public.availability_instances (owner_id, service_date, status);
create index if not exists availability_instances_school_date_idx
  on public.availability_instances (school_id, service_date, status);

-- Day 6 consumes these immutable input records to score cancellation timing.
create table if not exists public.schedule_cancellation_events (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  pattern_id uuid not null references public.availability_patterns(id) on delete restrict,
  instance_id uuid not null references public.availability_instances(id) on delete restrict,
  service_date date not null,
  scope public.schedule_cancellation_scope not null,
  cancelled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (instance_id)
);
create index if not exists schedule_cancellation_events_owner_idx
  on public.schedule_cancellation_events (owner_id, cancelled_at desc);

-- ---------------------------------------------------------------------------
-- Helpers and immutable safety rules.
-- ---------------------------------------------------------------------------
create or replace function public.is_suburb_area_label(value text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select value = trim(value)
    and char_length(value) between 2 and 64
    and value ~ '^[A-Za-z][A-Za-z ''-]{1,63}$'
    and lower(value) !~ '(^|[[:space:]])(street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|crescent|cres|place|pl|boulevard|bvd|way|highway|hwy|terrace|tce|close|circuit|parade|pde|esplanade|esp)[.]?$'
$$;

alter table public.availability_patterns drop constraint if exists availability_patterns_area_label_check;
alter table public.availability_patterns add constraint availability_patterns_area_label_check
  check (public.is_suburb_area_label(area_label));
alter table public.availability_instances drop constraint if exists availability_instances_area_label_check;
alter table public.availability_instances add constraint availability_instances_area_label_check
  check (public.is_suburb_area_label(area_label));

create or replace function public.school_local_today(target_school uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select (now() at time zone school.timezone)::date
  from public.schools school where school.id = target_school
$$;

create or replace function public.is_instructional_school_date(target_school uuid, target_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
      select 1 from public.school_calendar_periods holiday
      where holiday.school_id = target_school
        and holiday.period_type = 'holiday'
        and target_date between holiday.starts_on and holiday.ends_on
    )
    and (
      not exists (
        select 1 from public.school_calendar_periods term
        where term.school_id = target_school and term.period_type = 'term'
      )
      or exists (
        select 1 from public.school_calendar_periods term
        where term.school_id = target_school
          and term.period_type = 'term'
          and target_date between term.starts_on and term.ends_on
      )
    )
$$;

-- This helper is intentionally available for future matching rules. It carries
-- no household detail: only a boolean for an already-known pair of user IDs.
create or replace function public.is_same_household(first_user uuid, second_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and (auth.uid() = first_user or auth.uid() = second_user or public.is_admin())
    and (
      first_user = second_user or exists (
        select 1 from public.household_links link
        where link.status = 'confirmed'
          and ((link.first_parent_id = first_user and link.second_parent_id = second_user)
            or (link.first_parent_id = second_user and link.second_parent_id = first_user))
      )
    )
$$;

create or replace function public.prevent_schedule_cancellation_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'schedule cancellation events are append-only' using errcode = '55000';
end;
$$;
drop trigger if exists schedule_cancellation_events_append_only on public.schedule_cancellation_events;
create trigger schedule_cancellation_events_append_only
before update or delete on public.schedule_cancellation_events
for each row execute function public.prevent_schedule_cancellation_mutation();

-- ---------------------------------------------------------------------------
-- Narrow, auditable commands. Ordinary clients never receive raw write grants.
-- ---------------------------------------------------------------------------
create or replace function public.request_household_link(other_parent uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare shared_school uuid;
declare existing_link uuid;
declare new_link uuid;
begin
  if auth.uid() is null or other_parent is null or other_parent = auth.uid() then
    raise exception 'a different confirmed parent is required' using errcode = '22023';
  end if;
  select first_membership.school_id into shared_school
  from public.school_memberships first_membership
  join public.school_memberships other_membership
    on other_membership.school_id = first_membership.school_id
  join public.profiles other_profile on other_profile.id = other_parent
  where first_membership.user_id = auth.uid()
    and other_membership.user_id = other_parent
    and first_membership.status = 'verified'
    and other_membership.status = 'verified'
    and not other_profile.admin_suspended
  order by first_membership.school_id
  limit 1;
  if shared_school is null or not public.is_member(shared_school) then
    raise exception 'a shared verified school is required' using errcode = '42501';
  end if;
  select link.id into existing_link
  from public.household_links link
  where link.school_id = shared_school
    and link.status in ('pending', 'confirmed')
    and least(link.first_parent_id, link.second_parent_id) = least(auth.uid(), other_parent)
    and greatest(link.first_parent_id, link.second_parent_id) = greatest(auth.uid(), other_parent)
  limit 1;
  if existing_link is not null then return existing_link; end if;
  insert into public.household_links (school_id, first_parent_id, second_parent_id, requested_by)
  values (shared_school, least(auth.uid(), other_parent), greatest(auth.uid(), other_parent), auth.uid())
  returning id into new_link;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), shared_school, 'household.requested', 'household_link', new_link, jsonb_build_object('outcome', 'pending'));
  return new_link;
end;
$$;

create or replace function public.confirm_household_link(link_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare link public.household_links%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select * into link from public.household_links where id = link_id for update;
  if link.id is null then raise exception 'household request not found' using errcode = 'P0002'; end if;
  if link.status = 'confirmed' and (link.first_parent_id = auth.uid() or link.second_parent_id = auth.uid()) then return 'confirmed'; end if;
  if link.status <> 'pending' or link.requested_by = auth.uid()
    or not (link.first_parent_id = auth.uid() or link.second_parent_id = auth.uid())
    or not public.is_member(link.school_id) then
    raise exception 'household confirmation is not permitted' using errcode = '42501';
  end if;
  update public.household_links
  set status = 'confirmed', other_parent_confirmed_at = now(), updated_at = now()
  where id = link.id;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), link.school_id, 'household.confirmed', 'household_link', link.id, jsonb_build_object('outcome', 'confirmed'));
  return 'confirmed';
end;
$$;

-- The token is returned once to the requester. Only its digest is stored.
create or replace function public.create_household_link_invitation()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare school uuid;
declare token text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select membership.school_id into school
  from public.school_memberships membership
  where membership.user_id = auth.uid()
    and membership.status = 'verified'
    and public.is_member(membership.school_id)
  order by membership.created_at
  limit 1;
  if school is null then raise exception 'verified school membership required' using errcode = '42501'; end if;
  token := encode(gen_random_bytes(24), 'hex');
  insert into public.household_link_invitations (school_id, invited_by, token_hash, expires_at)
  values (school, auth.uid(), encode(digest(token, 'sha256'), 'hex'), now() + interval '7 days');
  insert into public.audit_logs (actor_id, school_id, action, entity_type, payload)
  values (auth.uid(), school, 'household.invitation_created', 'household_link_invitation', jsonb_build_object('outcome', 'sent'));
  return token;
end;
$$;

create or replace function public.claim_household_link_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare invitation public.household_link_invitations%rowtype;
declare existing_link public.household_links%rowtype;
declare link_id uuid;
begin
  if auth.uid() is null or char_length(trim(p_token)) <> 48 then
    raise exception 'household confirmation code is unavailable' using errcode = 'P0002';
  end if;
  select * into invitation from public.household_link_invitations
  where token_hash = encode(digest(trim(p_token), 'sha256'), 'hex')
    and expires_at > now()
  for update;
  if invitation.id is null or invitation.claimed_by is not null or invitation.invited_by = auth.uid()
    or not public.is_member(invitation.school_id) then
    raise exception 'household confirmation code is unavailable' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.school_memberships membership
    where membership.school_id = invitation.school_id
      and membership.user_id = auth.uid()
      and membership.status = 'verified'
  ) then
    raise exception 'household confirmation code is unavailable' using errcode = 'P0002';
  end if;
  select * into existing_link from public.household_links link
  where link.school_id = invitation.school_id
    and link.status in ('pending', 'confirmed')
    and least(link.first_parent_id, link.second_parent_id) = least(invitation.invited_by, auth.uid())
    and greatest(link.first_parent_id, link.second_parent_id) = greatest(invitation.invited_by, auth.uid())
  for update;
  if existing_link.id is null then
    insert into public.household_links (
      school_id, first_parent_id, second_parent_id, requested_by,
      requester_confirmed_at, other_parent_confirmed_at, status
    ) values (
      invitation.school_id, least(invitation.invited_by, auth.uid()), greatest(invitation.invited_by, auth.uid()),
      invitation.invited_by, now(), now(), 'confirmed'
    ) returning id into link_id;
  elsif existing_link.status = 'confirmed' then
    link_id := existing_link.id;
  elsif existing_link.requested_by = invitation.invited_by then
    update public.household_links set status = 'confirmed', other_parent_confirmed_at = now(), updated_at = now()
    where id = existing_link.id;
    link_id := existing_link.id;
  else
    raise exception 'household confirmation code is unavailable' using errcode = 'P0002';
  end if;
  update public.household_link_invitations set claimed_by = auth.uid(), claimed_at = now() where id = invitation.id;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), invitation.school_id, 'household.invitation_claimed', 'household_link', link_id, jsonb_build_object('outcome', 'confirmed'));
  return link_id;
end;
$$;

create or replace function public.expand_availability_pattern(pattern_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare pattern public.availability_patterns%rowtype;
declare school_today date;
declare target_date date;
declare created_count integer := 0;
begin
  select * into pattern from public.availability_patterns where id = pattern_id;
  if pattern.id is null or not pattern.is_active then return 0; end if;
  school_today := public.school_local_today(pattern.school_id);
  for target_date in
    select generate_series(greatest(pattern.starts_on, school_today), greatest(pattern.starts_on, school_today) + 27, interval '1 day')::date
  loop
    if extract(isodow from target_date) = pattern.weekday
      and public.is_instructional_school_date(pattern.school_id, target_date) then
      insert into public.availability_instances (
        pattern_id, school_id, owner_id, service_date, intent, direction,
        window_start, window_end, area_label, capacity
      ) values (
        pattern.id, pattern.school_id, pattern.owner_id, target_date, pattern.intent, pattern.direction,
        pattern.window_start, pattern.window_end, pattern.area_label, pattern.capacity
      ) on conflict (pattern_id, service_date) do nothing;
      if found then created_count := created_count + 1; end if;
    end if;
  end loop;
  return created_count;
end;
$$;

-- Every authenticated calendar refresh tops active owned patterns back up to a
-- rolling four-week horizon. The internal expansion function itself is not
-- callable by browser roles.
create or replace function public.refresh_my_availability_instances()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare pattern record;
declare created_count integer := 0;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  for pattern in
    select id, school_id from public.availability_patterns
    where owner_id = auth.uid() and is_active
  loop
    if public.is_member(pattern.school_id) then
      created_count := created_count + public.expand_availability_pattern(pattern.id);
    end if;
  end loop;
  return created_count;
end;
$$;

create or replace function public.create_availability_pattern(
  p_school_id uuid,
  p_intent text,
  p_direction text,
  p_weekday smallint,
  p_window_start time,
  p_window_end time,
  p_area_label text,
  p_capacity smallint,
  p_starts_on date
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare new_pattern uuid;
declare school_today date;
begin
  if auth.uid() is null or not public.is_member(p_school_id) then raise exception 'verified school membership required' using errcode = '42501'; end if;
  if p_intent not in ('can_help', 'need_help') or p_direction not in ('pickup', 'dropoff')
    or p_weekday not between 1 and 7 or p_capacity not between 1 and 8
    or p_window_start is null or p_window_end is null or p_window_end <= p_window_start
    or not public.is_suburb_area_label(trim(p_area_label)) then
    raise exception 'schedule pattern is invalid' using errcode = '22023';
  end if;
  school_today := public.school_local_today(p_school_id);
  if p_starts_on < school_today then raise exception 'start date cannot be in the past' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  insert into public.availability_patterns (
    school_id, owner_id, intent, direction, weekday, window_start, window_end, area_label, capacity, starts_on
  ) values (
    p_school_id, auth.uid(), p_intent::public.schedule_intent, p_direction::public.school_run_direction,
    p_weekday, p_window_start, p_window_end, trim(p_area_label), p_capacity, p_starts_on
  ) returning id into new_pattern;
  perform public.expand_availability_pattern(new_pattern);
  if not exists (select 1 from public.analytics_events where actor_id = auth.uid() and event_name = 'first_listing_created') then
    insert into public.analytics_events (actor_id, school_id, event_name)
    values (auth.uid(), p_school_id, 'first_listing_created');
  end if;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), p_school_id, 'schedule.pattern_created', 'availability_pattern', new_pattern, jsonb_build_object('outcome', 'expanded'));
  return new_pattern;
end;
$$;

create or replace function public.update_availability_pattern(
  p_pattern_id uuid,
  p_intent text,
  p_direction text,
  p_weekday smallint,
  p_window_start time,
  p_window_end time,
  p_area_label text,
  p_capacity smallint,
  p_starts_on date
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare pattern public.availability_patterns%rowtype;
declare school_today date;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_intent not in ('can_help', 'need_help') or p_direction not in ('pickup', 'dropoff')
    or p_weekday not between 1 and 7 or p_capacity not between 1 and 8
    or p_window_start is null or p_window_end is null or p_window_end <= p_window_start
    or not public.is_suburb_area_label(trim(p_area_label)) then
    raise exception 'schedule pattern is invalid' using errcode = '22023';
  end if;
  select * into pattern from public.availability_patterns where id = p_pattern_id and owner_id = auth.uid() for update;
  if pattern.id is null or not pattern.is_active or not public.is_member(pattern.school_id) then raise exception 'active owned pattern required' using errcode = '42501'; end if;
  school_today := public.school_local_today(pattern.school_id);
  if p_starts_on < school_today then raise exception 'start date cannot be in the past' using errcode = '22023'; end if;
  update public.availability_patterns set
    intent = p_intent::public.schedule_intent, direction = p_direction::public.school_run_direction,
    weekday = p_weekday, window_start = p_window_start, window_end = p_window_end,
    area_label = trim(p_area_label), capacity = p_capacity, starts_on = p_starts_on, updated_at = now()
  where id = pattern.id;
  delete from public.availability_instances
  where pattern_id = pattern.id and service_date >= school_today and status = 'open';
  perform public.expand_availability_pattern(pattern.id);
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), pattern.school_id, 'schedule.pattern_updated', 'availability_pattern', pattern.id, jsonb_build_object('outcome', 'reexpanded'));
  return pattern.id;
end;
$$;

create or replace function public.cancel_availability_instance(p_instance_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare instance public.availability_instances%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select * into instance from public.availability_instances where id = p_instance_id and owner_id = auth.uid() for update;
  if instance.id is null or instance.status <> 'open' or not public.is_member(instance.school_id) then raise exception 'open owned instance required' using errcode = '42501'; end if;
  update public.availability_instances set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = instance.id;
  insert into public.schedule_cancellation_events (school_id, owner_id, pattern_id, instance_id, service_date, scope)
  values (instance.school_id, auth.uid(), instance.pattern_id, instance.id, instance.service_date, 'instance') on conflict (instance_id) do nothing;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), instance.school_id, 'schedule.instance_cancelled', 'availability_instance', instance.id, jsonb_build_object('outcome', 'cancelled'));
  return 'cancelled';
end;
$$;

create or replace function public.cancel_availability_pattern(p_pattern_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare pattern public.availability_patterns%rowtype;
declare instance public.availability_instances%rowtype;
declare cancelled_count integer := 0;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select * into pattern from public.availability_patterns where id = p_pattern_id and owner_id = auth.uid() for update;
  if pattern.id is null or not pattern.is_active or not public.is_member(pattern.school_id) then raise exception 'active owned pattern required' using errcode = '42501'; end if;
  update public.availability_patterns set is_active = false, cancelled_at = now(), updated_at = now() where id = pattern.id;
  for instance in
    update public.availability_instances
    set status = 'cancelled', cancelled_at = now(), updated_at = now()
    where pattern_id = pattern.id and status = 'open' and service_date >= public.school_local_today(pattern.school_id)
    returning *
  loop
    insert into public.schedule_cancellation_events (school_id, owner_id, pattern_id, instance_id, service_date, scope)
    values (instance.school_id, auth.uid(), pattern.id, instance.id, instance.service_date, 'pattern') on conflict (instance_id) do nothing;
    cancelled_count := cancelled_count + 1;
  end loop;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), pattern.school_id, 'schedule.pattern_cancelled', 'availability_pattern', pattern.id, jsonb_build_object('outcome', 'cancelled'));
  return cancelled_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Analytics and RLS. No raw schedule mutation is exposed to clients.
-- ---------------------------------------------------------------------------
alter table public.analytics_events drop constraint if exists analytics_events_allowed_name_check;
alter table public.analytics_events add constraint analytics_events_allowed_name_check check (
  event_name in (
    'signed_up', 'email_verified', 'school_joined', 'approved', 'child_added',
    'declaration_signed', 'invite_sent', 'invite_joined', 'first_listing_created'
  )
);
create unique index if not exists analytics_first_listing_once_idx
  on public.analytics_events (actor_id, event_name) where event_name = 'first_listing_created';

alter table public.household_links enable row level security;
alter table public.household_link_invitations enable row level security;
alter table public.school_calendar_periods enable row level security;
alter table public.availability_patterns enable row level security;
alter table public.availability_instances enable row level security;
alter table public.schedule_cancellation_events enable row level security;

create policy household_links_select_participant_or_admin on public.household_links
  for select to authenticated using (
    ((first_parent_id = auth.uid() or second_parent_id = auth.uid()) and public.is_member(school_id))
    or public.is_admin()
  );
create policy calendar_periods_select_own_school on public.school_calendar_periods
  for select to authenticated using (public.is_member(school_id) or public.is_admin());
create policy calendar_periods_moderator_or_admin_manage on public.school_calendar_periods
  for all to authenticated
  using (public.is_moderator(school_id) or public.is_admin())
  with check (public.is_moderator(school_id) or public.is_admin());
create policy availability_patterns_select_owner_or_admin on public.availability_patterns
  for select to authenticated using ((owner_id = auth.uid() and public.is_member(school_id)) or public.is_admin());
create policy availability_instances_select_owner_or_admin on public.availability_instances
  for select to authenticated using ((owner_id = auth.uid() and public.is_member(school_id)) or public.is_admin());
create policy schedule_cancellation_events_select_owner_or_admin on public.schedule_cancellation_events
  for select to authenticated using ((owner_id = auth.uid() and public.is_member(school_id)) or public.is_admin());

revoke all on public.household_links, public.household_link_invitations, public.school_calendar_periods,
  public.availability_patterns, public.availability_instances,
  public.schedule_cancellation_events from anon, authenticated;
grant select on public.household_links, public.availability_patterns,
  public.availability_instances, public.schedule_cancellation_events to authenticated;
grant select, insert, update, delete on public.school_calendar_periods to authenticated;

revoke all on function public.is_same_household(uuid, uuid) from public;
revoke all on function public.school_local_today(uuid) from public;
revoke all on function public.is_instructional_school_date(uuid, date) from public;
revoke all on function public.expand_availability_pattern(uuid) from public;
revoke all on function public.request_household_link(uuid) from public;
revoke all on function public.confirm_household_link(uuid) from public;
revoke all on function public.create_household_link_invitation() from public;
revoke all on function public.claim_household_link_invitation(text) from public;
revoke all on function public.refresh_my_availability_instances() from public;
revoke all on function public.create_availability_pattern(uuid, text, text, smallint, time, time, text, smallint, date) from public;
revoke all on function public.update_availability_pattern(uuid, text, text, smallint, time, time, text, smallint, date) from public;
revoke all on function public.cancel_availability_instance(uuid) from public;
revoke all on function public.cancel_availability_pattern(uuid) from public;
grant execute on function public.is_same_household(uuid, uuid) to authenticated;
grant execute on function public.refresh_my_availability_instances() to authenticated;
grant execute on function public.request_household_link(uuid) to authenticated;
grant execute on function public.confirm_household_link(uuid) to authenticated;
grant execute on function public.create_household_link_invitation() to authenticated;
grant execute on function public.claim_household_link_invitation(text) to authenticated;
grant execute on function public.create_availability_pattern(uuid, text, text, smallint, time, time, text, smallint, date) to authenticated;
grant execute on function public.update_availability_pattern(uuid, text, text, smallint, time, time, text, smallint, date) to authenticated;
grant execute on function public.cancel_availability_instance(uuid) to authenticated;
grant execute on function public.cancel_availability_pattern(uuid) to authenticated;

-- Period changes are school-scoped, audited administrative actions.
drop trigger if exists audit_school_calendar_periods_change on public.school_calendar_periods;
create trigger audit_school_calendar_periods_change
after insert or update or delete on public.school_calendar_periods
for each row execute function public.audit_sensitive_change();

commit;

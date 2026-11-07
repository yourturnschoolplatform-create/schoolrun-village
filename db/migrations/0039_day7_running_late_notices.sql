-- Task 7.4: running-late notice store and late trust penalty on pickup confirmation.
-- Prior notice before pickup window start → late_with_advance_notice (−2);
-- otherwise 15+ minutes after window start → late_without_advance_notice (−5).
-- No live location, phone, amount, price or currency.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.running_late_notices (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  swap_id uuid not null references public.swap_proposals(id) on delete restrict,
  swap_leg_id uuid not null,
  posted_by uuid not null references public.profiles(id) on delete restrict,
  posted_by_membership uuid not null,
  window_starts_at timestamptz not null,
  posted_at timestamptz not null default pg_catalog.now(),
  check (posted_at < window_starts_at),
  foreign key (swap_leg_id, school_id) references public.swap_legs(id, school_id) on delete restrict,
  foreign key (posted_by_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict
);
create unique index running_late_notices_one_per_leg_idx
  on public.running_late_notices (swap_leg_id);
create index running_late_notices_school_idx
  on public.running_late_notices (school_id, posted_at desc);
create index running_late_notices_poster_idx
  on public.running_late_notices (posted_by, posted_at desc);
alter table public.running_late_notices
  add constraint running_late_notices_id_school_key unique (id, school_id);

comment on table public.running_late_notices is
  'Prior running-late notice before pickup window start. No location, phone, nickname, amount, price or currency.';

create function public.guard_running_late_notices()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'running late notices are append-only' using errcode = '55000';
  end if;
  if new.posted_at >= new.window_starts_at then
    raise exception 'running late notice must be posted before the pickup window starts'
      using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_running_late_notices() from public, anon, authenticated;
create trigger running_late_notices_guard_rows
  before insert or update or delete on public.running_late_notices
  for each row execute function public.guard_running_late_notices();
create trigger running_late_notices_guard_truncate
  before truncate on public.running_late_notices
  for each statement execute function public.guard_running_late_notices();
alter table public.running_late_notices enable always trigger running_late_notices_guard_rows;
alter table public.running_late_notices enable always trigger running_late_notices_guard_truncate;

alter table public.running_late_notices enable row level security;
create policy running_late_notices_select on public.running_late_notices
  for select to authenticated using (
    public.is_admin()
    or posted_by = auth.uid()
    or exists (
      select 1
      from public.swap_legs leg
      where leg.id = running_late_notices.swap_leg_id
        and leg.school_id = running_late_notices.school_id
        and auth.uid() in (leg.helper_id, leg.requester_id)
        and public.is_member(leg.school_id)
    )
  );
revoke all on table public.running_late_notices from public, anon, authenticated;
grant select on table public.running_late_notices to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers / RPCs
-- ---------------------------------------------------------------------------
create function public.running_late_pickup_window_start(p_leg public.swap_legs)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.timezone(school.timezone, need.service_date + need.window_start)
  from public.availability_instances need
  join public.schools school on school.id = p_leg.school_id
  where need.id = p_leg.requester_instance_id;
$$;
revoke all on function public.running_late_pickup_window_start(public.swap_legs)
  from public, anon, authenticated;

create function public.running_late_notice_json(p_notice public.running_late_notices)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_notice.id,
    'school_id', p_notice.school_id,
    'swap_id', p_notice.swap_id,
    'swap_leg_id', p_notice.swap_leg_id,
    'posted_by', p_notice.posted_by,
    'window_starts_at', p_notice.window_starts_at,
    'posted_at', p_notice.posted_at
  );
$$;
revoke all on function public.running_late_notice_json(public.running_late_notices)
  from public, anon, authenticated;

create function public.post_running_late_notice(p_swap_leg_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  leg public.swap_legs%rowtype;
  proposal public.swap_proposals%rowtype;
  caller public.school_memberships%rowtype;
  existing public.running_late_notices%rowtype;
  created public.running_late_notices%rowtype;
  window_start timestamptz;
  event_time timestamptz;
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
  if auth.uid() is distinct from leg.helper_id
    or not public.is_member(leg.school_id) then
    raise exception 'accepted swap helper required' using errcode = '42501';
  end if;

  select * into caller
  from public.school_memberships membership
  where membership.school_id = leg.school_id
    and membership.user_id = auth.uid()
    and membership.status = 'verified';
  if caller.id is null then
    raise exception 'verified membership required' using errcode = '42501';
  end if;

  select row_notice.* into existing
  from public.running_late_notices as row_notice
  where row_notice.swap_leg_id = leg.id
  for update;
  if existing.id is not null then
    return public.running_late_notice_json(existing);
  end if;

  window_start := public.running_late_pickup_window_start(leg);
  if window_start is null then
    raise exception 'pickup window unavailable' using errcode = 'P0002';
  end if;
  event_time := pg_catalog.clock_timestamp();
  if event_time >= window_start then
    raise exception 'running late notice must be posted before the pickup window starts'
      using errcode = '22023';
  end if;

  insert into public.running_late_notices (
    school_id, swap_id, swap_leg_id, posted_by, posted_by_membership,
    window_starts_at, posted_at
  ) values (
    leg.school_id, leg.swap_id, leg.id, auth.uid(), caller.id,
    window_start, event_time
  ) returning * into created;

  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), leg.school_id, 'running_late.posted', 'running_late_notice', created.id,
    pg_catalog.jsonb_build_object('outcome', 'posted', 'reason_code', 'running_late')
  );

  return public.running_late_notice_json(created);
end;
$$;
revoke all on function public.post_running_late_notice(uuid) from public, anon, authenticated;
grant execute on function public.post_running_late_notice(uuid) to authenticated;

create function public.get_running_late_notice(p_swap_leg_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  leg public.swap_legs%rowtype;
  notice public.running_late_notices%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into leg from public.swap_legs where id = p_swap_leg_id;
  if leg.id is null
    or auth.uid() not in (leg.helper_id, leg.requester_id)
    or not public.is_member(leg.school_id) then
    raise exception 'running late notice unavailable' using errcode = '42501';
  end if;
  select * into notice from public.running_late_notices where swap_leg_id = leg.id;
  if notice.id is null then
    return null;
  end if;
  return public.running_late_notice_json(notice);
end;
$$;
revoke all on function public.get_running_late_notice(uuid) from public, anon, authenticated;
grant execute on function public.get_running_late_notice(uuid) to authenticated;

create function public.list_my_running_late_notices()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.jsonb_agg(public.running_late_notice_json(notice) order by notice.posted_at desc),
                  '[]'::jsonb)
    into result
  from public.running_late_notices notice
  join public.swap_legs leg on leg.id = notice.swap_leg_id
  where auth.uid() in (notice.posted_by, leg.helper_id, leg.requester_id)
    and public.is_member(notice.school_id);
  return result;
end;
$$;
revoke all on function public.list_my_running_late_notices() from public, anon, authenticated;
grant execute on function public.list_my_running_late_notices() to authenticated;

-- ---------------------------------------------------------------------------
-- Late trust posting on pickup_done confirmation
-- ---------------------------------------------------------------------------
create function public.post_trust_late_arrival()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  leg public.swap_legs%rowtype;
  window_start timestamptz;
  minutes_late numeric;
  has_notice boolean;
  reason text;
begin
  if new.confirmation_kind is distinct from 'pickup_done' then
    return new;
  end if;

  select * into leg from public.swap_legs where id = new.swap_leg_id;
  if leg.id is null then
    return new;
  end if;

  window_start := public.running_late_pickup_window_start(leg);
  if window_start is null then
    return new;
  end if;

  minutes_late := extract(epoch from (new.confirmed_at - window_start)) / 60.0;
  if minutes_late is null or minutes_late < 15 then
    return new;
  end if;

  -- A stored notice already required posted_at < its captured window_starts_at.
  select exists (
    select 1
    from public.running_late_notices notice
    where notice.swap_leg_id = leg.id
      and notice.posted_at < notice.window_starts_at
  ) into has_notice;

  reason := case
    when has_notice then 'late_with_advance_notice'
    else 'late_without_advance_notice'
  end;

  perform public.apply_trust_score_delta(
    leg.helper_id,
    leg.school_id,
    public.trust_policy_delta(leg.school_id, reason),
    reason,
    'swap_leg',
    leg.id
  );
  return new;
end;
$$;
revoke all on function public.post_trust_late_arrival() from public, anon, authenticated;

create trigger swap_leg_confirmation_late_trust
  after insert on public.swap_leg_confirmations
  for each row execute function public.post_trust_late_arrival();
alter table public.swap_leg_confirmations
  enable always trigger swap_leg_confirmation_late_trust;

commit;

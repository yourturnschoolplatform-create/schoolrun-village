-- Fix Request Match 22023 "instant pickup window has already passed".
--
-- Root cause:
--   accept_instant_pickup_request rejects when now() >= instant_pickup_pickup_at().
--   pickup_at is a FIXED school-local instant (dropoff 08:30 / pickup 15:15), not a
--   stored window. Open posts stay listed after that instant (and yesterday via
--   target_date >= today-1), so Request Match fails repeatedly on still-visible cards.
--
-- Fix:
--   1) Match deadline = end of target_date in the school timezone (exclusive next local midnight).
--   2) Expire open posts past that deadline (and sweep on list/accept).
--   3) Keep pickup_at for display / check-in; final_check_at adjusts if matching after pickup_at.
begin;
set local search_path = pg_catalog;

-- End of the request's target_date in school-local time (as timestamptz).
create or replace function public.instant_pickup_match_deadline(
  p_request public.instant_pickup_requests
)
returns timestamptz
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  school_tz text;
begin
  select school.timezone into school_tz
  from public.schools as school
  where school.id = p_request.school_id;
  if school_tz is null then
    raise exception 'school timezone unavailable' using errcode = 'P0002';
  end if;
  -- Interpret local midnight of (target_date + 1 day) as the exclusive end of the day.
  return pg_catalog.timezone(school_tz, (p_request.target_date + 1)::timestamp);
end;
$fn$;

revoke all on function public.instant_pickup_match_deadline(public.instant_pickup_requests)
  from public, anon, authenticated;

comment on function public.instant_pickup_match_deadline(public.instant_pickup_requests) is
  'School-local end of target_date (next local midnight as timestamptz). Match allowed while now() < deadline.';

-- Expire open posts whose school-local day has ended.
create or replace function public.expire_stale_open_instant_pickup_requests()
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  stale_id uuid;
  expired_count integer := 0;
begin
  loop
    select request.id into stale_id
    from public.instant_pickup_requests as request
    where request.status = 'open'
      and pg_catalog.now() >= public.instant_pickup_match_deadline(request)
    order by request.target_date asc, request.created_at asc
    for update of request skip locked
    limit 1;

    exit when stale_id is null;

    perform set_config('yourturn.instant_pickup_mutate', '1', true);
    update public.instant_pickup_requests as row_request
    set status = 'expired'
    where row_request.id = stale_id
      and row_request.status = 'open';
    perform set_config('yourturn.instant_pickup_mutate', '', true);

    expired_count := expired_count + 1;
    stale_id := null;
  end loop;
  return expired_count;
end;
$fn$;

revoke all on function public.expire_stale_open_instant_pickup_requests()
  from public, anon, authenticated;

comment on function public.expire_stale_open_instant_pickup_requests() is
  'Marks open instant pickup posts expired after school-local end of target_date.';

-- List: sweep stale opens + stale matches; do not surface expired opens as matchable.
create or replace function public.list_instant_pickup_requests(p_include_closed boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  membership public.school_memberships%rowtype;
  school_today date;
begin
  membership := public.instant_pickup_caller_membership();
  perform public.expire_stale_open_instant_pickup_requests();
  perform public.release_stale_instant_pickup_matches();
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
        or request.matched_user_id = auth.uid()
      )
  ), '[]'::jsonb);
end;
$fn$;

revoke all on function public.list_instant_pickup_requests(boolean)
  from public, anon, authenticated;
grant execute on function public.list_instant_pickup_requests(boolean) to authenticated;

-- Accept: match until end of school-local target_date (not the 08:30/15:15 display instant).
drop function if exists public.accept_instant_pickup_request(uuid);

create function public.accept_instant_pickup_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  request public.instant_pickup_requests%rowtype;
  room public.chat_rooms%rowtype;
  low_id uuid;
  high_id uuid;
  pickup_at timestamptz;
  match_deadline timestamptz;
  checkpoint timestamptz;
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'p_request_id is required' using errcode = '22023';
  end if;

  perform public.expire_stale_open_instant_pickup_requests();
  perform public.release_stale_instant_pickup_matches();

  select * into request
  from public.instant_pickup_requests
  where id = p_request_id
  for update;

  if request.id is null then
    raise exception 'instant pickup request unavailable' using errcode = '42501';
  end if;

  if request.requester_id = caller then
    raise exception 'You cannot request a match on your own pickup post.'
      using errcode = '22023';
  end if;

  if not public.instant_pickup_has_school_access(request.school_id) then
    raise exception 'Join and verify your school profile before requesting a match.'
      using errcode = '42501';
  end if;

  if request.status is distinct from 'open' then
    raise exception 'instant pickup request is not open' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles as profile
    where profile.id = request.requester_id
      and not profile.admin_suspended
  ) then
    raise exception 'instant pickup requester unavailable' using errcode = '42501';
  end if;

  low_id := case
    when caller::text < request.requester_id::text then caller
    else request.requester_id
  end;
  high_id := case
    when caller::text < request.requester_id::text then request.requester_id
    else caller
  end;

  pickup_at := public.instant_pickup_pickup_at(request);
  match_deadline := public.instant_pickup_match_deadline(request);

  -- Same-day board: allow match through end of the school-local target date.
  if pg_catalog.now() >= match_deadline then
    perform set_config('yourturn.instant_pickup_mutate', '1', true);
    update public.instant_pickup_requests as row_request
    set status = 'expired'
    where row_request.id = request.id
      and row_request.status = 'open';
    perform set_config('yourturn.instant_pickup_mutate', '', true);
    raise exception 'instant pickup window has already passed' using errcode = '22023';
  end if;

  -- Check-in anchor: prefer 30 minutes before the default run time; if that is
  -- already past (late match), give parents a short confirmation window from now.
  if pickup_at - interval '30 minutes' > pg_catalog.now() then
    checkpoint := pickup_at - interval '30 minutes';
  else
    checkpoint := pg_catalog.now() + interval '20 minutes';
  end if;

  select * into room
  from public.chat_rooms
  where instant_pickup_request_id = request.id
  for update;

  if room.id is null then
    perform set_config('yourturn.chat_room_mutate', '1', true);
    insert into public.chat_rooms (
      school_id,
      availability_pattern_id,
      instant_pickup_request_id,
      item_listing_id,
      community_thread_id,
      user_low,
      user_high
    ) values (
      request.school_id,
      null,
      request.id,
      null,
      null,
      low_id,
      high_id
    ) returning * into room;
    insert into public.chat_participants (room_id, school_id, user_id)
    values
      (room.id, room.school_id, low_id),
      (room.id, room.school_id, high_id);
    perform set_config('yourturn.chat_room_mutate', '', true);
  end if;

  perform set_config('yourturn.instant_pickup_mutate', '1', true);
  update public.instant_pickup_requests as row_request
  set
    status = 'matched',
    matched_user_id = caller,
    check_in_status = 'pending',
    final_check_at = checkpoint,
    chat_room_id = room.id
  where row_request.id = request.id
  returning * into request;
  perform set_config('yourturn.instant_pickup_mutate', '', true);

  return pg_catalog.jsonb_build_object(
    'request', public.instant_pickup_request_json(request),
    'chatRoom', public.chat_room_json(room)
  );
end;
$fn$;

comment on function public.accept_instant_pickup_request(uuid) is
  'PostgREST: { "p_request_id": "<uuid>" }. Match allowed until school-local end of target_date. Returns { request, chatRoom }.';

revoke all on function public.accept_instant_pickup_request(uuid)
  from public, anon, authenticated;
grant execute on function public.accept_instant_pickup_request(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;

-- Re-assert get_instant_pickup_chat(p_request_id uuid) for PostgREST.
-- Frontend must call: rpc('get_instant_pickup_chat', { p_request_id: <uuid> })
-- DROP + CREATE clears stale argument names; NOTIFY refreshes schema cache (PGRST202/42883).
-- Also harden chat_weekday_label so integer isodow casts cannot raise 42883 inside chat_room_json.
begin;
set local search_path = pg_catalog;

-- integer → smallint bridge (date_part('isodow') often arrives as integer/float).
create or replace function public.chat_weekday_label(p_weekday integer)
returns text
language sql
immutable
set search_path = pg_catalog
as $fn$
  select public.chat_weekday_label(p_weekday::smallint);
$fn$;

revoke all on function public.chat_weekday_label(integer)
  from public, anon, authenticated;

create or replace function public.chat_instant_pickup_pin_json(
  p_request public.instant_pickup_requests
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select pg_catalog.jsonb_build_object(
    'patternId', p_request.id,
    'weekday', pg_catalog.date_part('isodow', p_request.target_date)::integer,
    'weekdayLabel', public.chat_weekday_label(
      pg_catalog.date_part('isodow', p_request.target_date)::smallint
    ),
    'windowStart', public.instant_pickup_default_window(p_request.direction)::text,
    'windowEnd', (
      public.instant_pickup_default_window(p_request.direction)
      + interval '30 minutes'
    )::time::text,
    'areaLabel', p_request.area_label,
    'direction', p_request.direction::text,
    'intent', p_request.intent::text,
    'pinKind', 'instant_pickup'
  )
$fn$;

revoke all on function public.chat_instant_pickup_pin_json(public.instant_pickup_requests)
  from public, anon, authenticated;

drop function if exists public.get_instant_pickup_chat(uuid);

create function public.get_instant_pickup_chat(p_request_id uuid)
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
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'p_request_id is required' using errcode = '22023';
  end if;

  select * into request
  from public.instant_pickup_requests
  where id = p_request_id
  for update;

  if request.id is null
    or request.status is distinct from 'matched'
    or request.matched_user_id is null
    or auth.uid() not in (request.requester_id, request.matched_user_id)
    or not public.instant_pickup_has_school_access(request.school_id) then
    raise exception 'instant pickup chat unavailable' using errcode = '42501';
  end if;

  if request.chat_room_id is not null then
    select * into room
    from public.chat_rooms
    where id = request.chat_room_id;
  end if;

  if room.id is null then
    select * into room
    from public.chat_rooms
    where instant_pickup_request_id = request.id
    for update;
  end if;

  if room.id is null then
    low_id := pg_catalog.least(request.requester_id, request.matched_user_id);
    high_id := pg_catalog.greatest(request.requester_id, request.matched_user_id);

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

  if request.chat_room_id is distinct from room.id then
    perform set_config('yourturn.instant_pickup_mutate', '1', true);
    update public.instant_pickup_requests as row_request
    set chat_room_id = room.id
    where row_request.id = request.id;
    perform set_config('yourturn.instant_pickup_mutate', '', true);
  end if;

  return public.chat_room_json(room);
end;
$fn$;

comment on function public.get_instant_pickup_chat(uuid) is
  'PostgREST RPC args: { "p_request_id": "<uuid>" }. Get or create match chat for participants.';

revoke all on function public.get_instant_pickup_chat(uuid)
  from public, anon, authenticated;
grant execute on function public.get_instant_pickup_chat(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;

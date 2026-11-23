-- pg_catalog.least/greatest have no uuid overloads. Under search_path = pg_catalog,
-- get_instant_pickup_chat (and accept) raise 42883 when ordering peer user ids.
-- Compare uuid::text instead (stable for chat_rooms user_low / user_high).
begin;
set local search_path = pg_catalog;

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
    -- uuid has no pg_catalog.least/greatest; order by text form.
    low_id := case
      when request.requester_id::text < request.matched_user_id::text
        then request.requester_id
      else request.matched_user_id
    end;
    high_id := case
      when request.requester_id::text < request.matched_user_id::text
        then request.matched_user_id
      else request.requester_id
    end;

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

-- Same uuid ordering fix for accept (creates the room on first match).
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
  checkpoint timestamptz;
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'p_request_id is required' using errcode = '22023';
  end if;

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
  checkpoint := pickup_at - interval '30 minutes';
  if pg_catalog.now() >= pickup_at then
    raise exception 'instant pickup window has already passed' using errcode = '22023';
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
  'PostgREST RPC args: { "p_request_id": "<uuid>" }. Verified school members can match another user''s OPEN post. Returns { request, chatRoom }.';

revoke all on function public.accept_instant_pickup_request(uuid)
  from public, anon, authenticated;
grant execute on function public.accept_instant_pickup_request(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
